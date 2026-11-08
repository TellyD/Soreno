use super::Result;
use base64::{engine::general_purpose::STANDARD, Engine};

pub(super) const PROJECT_ICON_DATA_URL_LIMIT: usize = 32 * 1024;
pub(super) const PNG_DATA_URL_PREFIX: &str = "data:image/png;base64,";

fn validate_project_icon(data_url: &str) -> Result<()> {
    if data_url.len() > PROJECT_ICON_DATA_URL_LIMIT {
        return Err("L’icône du projet dépasse 32 Kio.".into());
    }
    let payload = data_url
        .strip_prefix(PNG_DATA_URL_PREFIX)
        .ok_or("L’icône du projet doit être une data URL PNG en base64.")?;
    let png = STANDARD
        .decode(payload)
        .map_err(|_| "L’icône du projet contient un base64 invalide.")?;
    if png.len() < 33
        || png[..8] != [137, 80, 78, 71, 13, 10, 26, 10]
        || png[8..12] != 13_u32.to_be_bytes()
        || &png[12..16] != b"IHDR"
    {
        return Err("L’icône du projet n’est pas un PNG valide avec un en-tête IHDR.".into());
    }
    let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
    if !(1..=64).contains(&width) || !(1..=64).contains(&height) {
        return Err("L’icône du projet doit mesurer entre 1 et 64 pixels.".into());
    }
    Ok(())
}

pub(super) fn validate_appearance(
    icon: Option<&str>,
    color: Option<&str>,
    icon_data_url: Option<&str>,
) -> Result<()> {
    if let Some(data_url) = icon_data_url {
        validate_project_icon(data_url)?;
    }
    if icon.is_some_and(|icon| {
        icon.is_empty()
            || icon.len() > 64
            || !icon
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    }) {
        return Err("Icône du projet invalide.".into());
    }
    if color.is_some_and(|color| {
        color.len() != 7
            || !color.starts_with('#')
            || !color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err("Couleur du projet invalide.".into());
    }
    Ok(())
}
