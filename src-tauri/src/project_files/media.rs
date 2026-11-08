use base64::{engine::general_purpose::STANDARD, Engine};

pub(super) fn image_mime_type(path: &str) -> Option<&'static str> {
    match path.rsplit_once('.')?.1.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

pub(crate) fn image_data_url(bytes: &[u8]) -> Option<String> {
    [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/avif",
        "image/bmp",
    ]
    .into_iter()
    .find(|media_type| valid_image_signature(media_type, bytes))
    .map(|media_type| format!("data:{media_type};base64,{}", STANDARD.encode(bytes)))
}

pub(crate) fn valid_image_signature(media_type: &str, bytes: &[u8]) -> bool {
    match media_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => {
            bytes.starts_with(b"RIFF") && bytes.get(8..12).is_some_and(|value| value == b"WEBP")
        }
        "image/avif" => {
            if bytes.get(4..8) != Some(b"ftyp") {
                return false;
            }
            let Some(size) = bytes
                .get(..4)
                .and_then(|value| <[u8; 4]>::try_from(value).ok())
                .map(u32::from_be_bytes)
            else {
                return false;
            };
            let (header_size, box_size) = match size {
                0 => (8, bytes.len()),
                1 => {
                    let Some(size) = bytes
                        .get(8..16)
                        .and_then(|value| <[u8; 8]>::try_from(value).ok())
                        .map(u64::from_be_bytes)
                        .and_then(|size| usize::try_from(size).ok())
                    else {
                        return false;
                    };
                    (16, size)
                }
                size => (8, size as usize),
            };
            let Some(brands) = bytes.get(header_size..box_size) else {
                return false;
            };
            if brands.len() < 8 || (brands.len() - 8) % 4 != 0 {
                return false;
            }
            brands
                .get(..4)
                .is_some_and(|brand| matches!(brand, b"avif" | b"avis"))
                || brands[8..]
                    .chunks_exact(4)
                    .any(|brand| matches!(brand, b"avif" | b"avis"))
        }
        "image/bmp" => bytes.starts_with(b"BM"),
        _ => false,
    }
}
