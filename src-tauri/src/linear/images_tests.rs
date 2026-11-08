use super::*;

const NAME: &str = "0123456789abcdef0123456789abcdef.png";

#[test]
fn local_kanban_image_urls_give_their_file_name_on_every_platform() {
    for url in [
        format!(
            "asset://localhost/%2Fhome%2Fada%2F.local%2Fshare%2Fsoreno%2Fkanban-images%2F{NAME}"
        ),
        format!(
            "http://asset.localhost/C%3A%5CUsers%5Cada%5CAppData%5Csoreno%5Ckanban-images%5C{NAME}"
        ),
        format!("https://asset.localhost/home/ada/kanban-images/{NAME}"),
    ] {
        assert_eq!(local_image_name(&url).as_deref(), Some(NAME), "{url}");
    }
}

#[test]
fn other_urls_are_not_local_kanban_images() {
    for url in [
        format!("asset://localhost/%2Fhome%2Fada%2Fnotes%2F{NAME}"),
        "asset://localhost/%2Fkanban-images%2Fnot-a-name.png".to_owned(),
        format!("asset://localhost/%2Fkanban-images%2F{NAME}%ZZ"),
        format!("https://uploads.linear.app/kanban-images/{NAME}"),
    ] {
        assert_eq!(local_image_name(&url), None, "{url}");
    }
}

#[test]
fn chevron_destinations_keep_quotes_and_parentheses_of_the_path() {
    for user in ["O'Connor", "Ada%20(work)"] {
        let url = format!(
            "http://asset.localhost/C%3A%5CUsers%5C{user}%5CAppData%5Csoreno%5Ckanban-images%5C{NAME}"
        );
        let text = format!("before ![x](<{url}>) after");
        let found: Vec<_> = local_image_urls(&text).collect();
        assert_eq!(found.len(), 1, "{text}");
        assert_eq!(found[0].as_str(), url);
        assert_eq!(
            &text[found[0].start() - 1..found[0].end() + 1],
            format!("<{url}>")
        );
        assert_eq!(local_image_name(found[0].as_str()).as_deref(), Some(NAME));
    }
}

#[test]
fn bare_local_urls_stop_at_markdown_delimiters() {
    let url = format!("asset://localhost/%2Fdata%2Fkanban-images%2F{NAME}");
    let text = format!("![x]({url}) and {url}'s copy");
    let found: Vec<_> = local_image_urls(&text)
        .map(|found| found.as_str())
        .collect();
    assert_eq!(found, [url.as_str(), url.as_str()]);
}

#[test]
fn text_without_local_images_is_kept_without_any_request() {
    let text =
        "![shot](https://uploads.linear.app/a/b) and [doc](asset://localhost/%2Fnotes%2Fa.png)";
    assert_eq!(
        tauri::async_runtime::block_on(upload_local_images(Path::new("/nowhere"), text)),
        Ok(text.to_owned())
    );
}

#[test]
fn a_missing_local_image_fails_before_any_request() {
    let text = format!("![shot](asset://localhost/%2Fdata%2Fkanban-images%2F{NAME})");
    assert!(
        tauri::async_runtime::block_on(upload_local_images(Path::new("/nowhere"), &text)).is_err()
    );
}

#[test]
fn only_linear_upload_urls_are_downloaded() {
    assert!(linear_upload_url("https://uploads.linear.app/a/b/shot.png?signature=1").is_ok());
    for url in [
        "http://uploads.linear.app/a/b",
        "https://uploads.linear.app.evil.test/a/b",
        "https://evil.test/uploads.linear.app/a/b",
        "https://linear.app/a/b",
        "https://uploads.linear.app:8443/a/b",
        "https://ada:secret@uploads.linear.app/a/b",
        "https://ada@uploads.linear.app/a/b",
        "uploads.linear.app/a/b",
        "",
    ] {
        assert!(linear_upload_url(url).is_err(), "{url}");
    }
}

#[test]
fn redirects_keep_the_key_only_on_the_linear_upload_host() {
    let current = linear_upload_url("https://uploads.linear.app/a/b").unwrap();
    let (next, authorized) = redirect_target(&current, "/c/d").unwrap();
    assert_eq!(next.as_str(), "https://uploads.linear.app/c/d");
    assert!(authorized);
    let (next, authorized) =
        redirect_target(&current, "https://storage.example.com/signed?x=1").unwrap();
    assert_eq!(next.host_str(), Some("storage.example.com"));
    assert!(!authorized);
    assert!(redirect_target(&current, "http://uploads.linear.app/c/d").is_err());
}

#[test]
fn prompt_images_without_urls_need_no_key() {
    assert!(tauri::async_runtime::block_on(download_prompt_images(&[])).is_empty());
}
