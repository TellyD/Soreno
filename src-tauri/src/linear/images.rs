use super::{
    api_key_for, authorization_header, graphql, linear_client, mutations::upload_target,
    mutations::validate_image, queries::FILE_UPLOAD_MUTATION, request_failed,
    responses::FileUploadData, try_workspaces, unavailable, workspaces_for, Result,
    AUTH_ERROR_MESSAGE,
};
use crate::kanban::images;
use regex::Regex;
use reqwest::header::{HeaderValue, AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, LOCATION};
use reqwest::{StatusCode, Url};
use serde_json::json;
use std::{collections::HashMap, path::Path, sync::LazyLock, time::Duration};

const IMAGE_UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const IMAGE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_IMAGE_REDIRECTS: usize = 5;
// Images are fetched with the API key, so only from Linear's asset host.
const LINEAR_UPLOADS_HOST: &str = "uploads.linear.app";
// The chevron form mirrors `markdownImage`: the destination may hold `'`, `(` or `)`.
static LOCAL_IMAGE_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"<((?:asset://localhost|https?://asset\.localhost)/[^\s<>]+)>|(?:asset://localhost|https?://asset\.localhost)/[^\s()<>"'\[\]]+"#,
    )
    .unwrap()
});
static LOCAL_IMAGE_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|/)kanban-images/([0-9a-f]{32}\.(?:png|jpg|gif|webp))$").unwrap()
});

/// Replaces every local Kanban image of `text` by its Linear upload: Linear cannot read local files.
/// The images go to the workspace holding `owner_id`, the issue or team the text is written to.
pub async fn upload_local_images(directory: &Path, owner_id: &str, text: &str) -> Result<String> {
    let mut uploaded: HashMap<String, String> = HashMap::new();
    let mut destination = None;
    let mut replaced = String::with_capacity(text.len());
    let mut copied = 0;
    for found in local_image_urls(text) {
        let Some(name) = local_image_name(found.as_str()) else {
            continue;
        };
        if !uploaded.contains_key(&name) {
            let (extension, bytes) = images::read_prompt_image(directory, &name)?;
            let (client, api_key) = match &mut destination {
                Some(destination) => destination,
                slot @ None => {
                    let client = linear_client()?;
                    let api_key = api_key_for(&client, owner_id).await?;
                    slot.insert((client, api_key))
                }
            };
            let asset_url =
                upload_image(client, api_key, &name, content_type(&extension), bytes).await?;
            uploaded.insert(name.clone(), asset_url);
        }
        replaced.push_str(&text[copied..found.start()]);
        replaced.push_str(&uploaded[&name]);
        copied = found.end();
    }
    replaced.push_str(&text[copied..]);
    Ok(replaced)
}

/// The local image URLs of `text`, without the chevrons around a Markdown destination.
fn local_image_urls(text: &str) -> impl Iterator<Item = regex::Match<'_>> {
    LOCAL_IMAGE_URL
        .captures_iter(text)
        .filter_map(|captures| captures.get(1).or_else(|| captures.get(0)))
}

/// Mirrors `kanbanImageName` in src/domain/kanban.ts.
fn local_image_name(url: &str) -> Option<String> {
    let (_, path) = url.split_once("localhost/")?;
    let path = percent_decoded(path)?.replace('\\', "/");
    LOCAL_IMAGE_PATH
        .captures(&path)
        .map(|captures| captures[1].to_owned())
}

fn percent_decoded(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = text.get(index + 1..index + 3)?;
            if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return None;
            }
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn content_type(extension: &str) -> &'static str {
    match extension {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "gif" => "image/gif",
        _ => "image/webp",
    }
}

/// Returns the asset URL to embed in Markdown; Linear serves it only to authenticated members.
async fn upload_image(
    client: &reqwest::Client,
    api_key: &str,
    filename: &str,
    content_type: &str,
    bytes: Vec<u8>,
) -> Result<String> {
    validate_image(content_type, bytes.len())?;
    let payload = graphql::<FileUploadData>(
        client,
        api_key,
        FILE_UPLOAD_MUTATION,
        json!({ "contentType": content_type, "filename": filename, "size": bytes.len() }),
    )
    .await?
    .file_upload;
    let target = upload_target(payload)?;
    // The signed URL only accepts the exact headers Linear returned.
    let mut request = client
        .put(&target.upload_url)
        .timeout(IMAGE_UPLOAD_TIMEOUT)
        .header(CONTENT_TYPE, content_type)
        .header(CACHE_CONTROL, "public, max-age=31536000");
    for header in &target.headers {
        request = request.header(&header.key, &header.value);
    }
    let status = request
        .body(bytes)
        .send()
        .await
        .map_err(|_| unavailable())?
        .status();
    if status.is_server_error() {
        return Err(unavailable());
    }
    if !status.is_success() {
        return Err(request_failed(format!(
            "l’envoi de l’image a échoué (HTTP {}).",
            status.as_u16()
        )));
    }
    Ok(target.asset_url)
}

/// The bytes of a Linear upload, which Linear serves only to authenticated members.
pub async fn load_image(url: &str) -> Result<Vec<u8>> {
    let url = linear_upload_url(url)?;
    let (_, bytes) = download_with_any_key(&download_client()?, url).await?;
    Ok(bytes)
}

/// Results keep the order of `urls` with the extension of each image; each download fails on its own.
pub async fn download_prompt_images(urls: &[String]) -> Vec<Result<(&'static str, Vec<u8>)>> {
    // Reading the key can prompt on macOS: never for an issue without Linear images.
    if urls.is_empty() {
        return Vec::new();
    }
    let client = download_client();
    let mut downloads = Vec::with_capacity(urls.len());
    for url in urls {
        downloads.push(match (&client, linear_upload_url(url)) {
            (Ok(client), Ok(url)) => download_with_any_key(client, url).await,
            (Err(error), _) => Err(error.clone()),
            (_, Err(error)) => Err(error),
        });
    }
    downloads
}

/// An upload is served to members of its workspace only: each key is tried, the one that served
/// the URL before first.
async fn download_with_any_key(
    client: &reqwest::Client,
    url: Url,
) -> Result<(&'static str, Vec<u8>)> {
    let (workspaces, _) = workspaces_for(url.as_str())?;
    try_workspaces(url.as_str(), workspaces, |workspace| {
        let url = url.clone();
        async move {
            let authorization = authorization_header(&workspace.api_key)?;
            download_image(client, &authorization, url).await.map(Some)
        }
    })
    .await
}

async fn download_image(
    client: &reqwest::Client,
    authorization: &HeaderValue,
    mut url: Url,
) -> Result<(&'static str, Vec<u8>)> {
    let mut authorized = true;
    let mut redirects = 0;
    let mut response = loop {
        let mut request = client.get(url.clone()).timeout(IMAGE_DOWNLOAD_TIMEOUT);
        if authorized {
            request = request.header(AUTHORIZATION, authorization.clone());
        }
        let response = request.send().await.map_err(|_| unavailable())?;
        if !response.status().is_redirection() {
            break response;
        }
        if redirects == MAX_IMAGE_REDIRECTS {
            return Err(request_failed("l’image Linear est redirigée trop de fois."));
        }
        redirects += 1;
        let location = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| request_failed("la redirection de l’image Linear est invalide."))?;
        (url, authorized) = redirect_target(&url, location)?;
    };
    let status = response.status();
    if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        return Err(AUTH_ERROR_MESSAGE.into());
    }
    if status.is_server_error() {
        return Err(unavailable());
    }
    if !status.is_success() {
        return Err(request_failed(format!(
            "le téléchargement de l’image a échoué (HTTP {}).",
            status.as_u16()
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length > images::MAX_IMAGE_BYTES as u64)
    {
        return Err(image_too_large());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
        if bytes.len() + chunk.len() > images::MAX_IMAGE_BYTES {
            return Err(image_too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    let (extension, _) = images::image_type(&bytes).ok_or_else(|| {
        request_failed("l’image Linear n’est pas une image PNG, JPEG, GIF ou WebP.")
    })?;
    Ok((extension, bytes))
}

fn image_too_large() -> String {
    request_failed("l’image Linear dépasse 25 Mo.")
}

// Redirects are followed by hand: reqwest re-sends Authorization on later same-host hops.
fn download_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(request_failed)
}

/// Resolves one redirect hop; the API key only follows hops that stay on Linear's upload host.
fn redirect_target(current: &Url, location: &str) -> Result<(Url, bool)> {
    let next = current
        .join(location)
        .map_err(|_| request_failed("la redirection de l’image Linear est invalide."))?;
    if next.scheme() != "https" {
        return Err(request_failed(
            "la redirection de l’image Linear n’est pas en https.",
        ));
    }
    let authorized = linear_upload_url(next.as_str()).is_ok();
    Ok((next, authorized))
}

fn linear_upload_url(url: &str) -> Result<Url> {
    let not_upload = || request_failed("cette adresse n’est pas une image envoyée sur Linear.");
    let parsed = Url::parse(url).map_err(|_| not_upload())?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some(LINEAR_UPLOADS_HOST)
        || parsed.port().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(not_upload());
    }
    Ok(parsed)
}

#[cfg(test)]
#[path = "images_tests.rs"]
mod tests;
