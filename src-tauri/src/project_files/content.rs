use super::{
    errors::conflict,
    media::{image_mime_type, valid_image_signature},
    ProjectFileContent, ProjectFileError,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};

pub(super) fn content_from_bytes(
    path: &str,
    bytes: Vec<u8>,
) -> Result<ProjectFileContent, ProjectFileError> {
    let version = version(&bytes);
    if let Some(media_type) =
        image_mime_type(path).filter(|media_type| valid_image_signature(media_type, &bytes))
    {
        return Ok(ProjectFileContent {
            path: path.into(),
            content: format!("data:{media_type};base64,{}", STANDARD.encode(bytes)),
            version,
            media_type: Some(media_type.into()),
        });
    }
    validate_text_bytes(&bytes)?;
    let content = String::from_utf8(bytes)
        .map_err(|_| ProjectFileError::new("encoding", "Ce fichier n’est pas encodé en UTF-8."))?;
    Ok(ProjectFileContent {
        path: path.into(),
        content,
        version,
        media_type: None,
    })
}

pub(super) fn validate_text_bytes(bytes: &[u8]) -> Result<(), ProjectFileError> {
    if bytes.contains(&0) {
        return Err(ProjectFileError::new(
            "binary",
            "Ce fichier binaire n’est pas éditable.",
        ));
    }
    std::str::from_utf8(bytes)
        .map(|_| ())
        .map_err(|_| ProjectFileError::new("encoding", "Ce fichier n’est pas encodé en UTF-8."))
}

pub(super) fn ensure_expected_version(
    bytes: &[u8],
    expected_version: &str,
) -> Result<(), ProjectFileError> {
    if version(bytes) == expected_version {
        Ok(())
    } else {
        Err(conflict())
    }
}

pub(super) fn version(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
