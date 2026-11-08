use super::ProjectFileError;

pub(super) fn invalid_path() -> ProjectFileError {
    ProjectFileError::new(
        "invalidPath",
        "Le chemin doit rester relatif au dossier du projet.",
    )
}

pub(super) fn too_large() -> ProjectFileError {
    ProjectFileError::new("tooLarge", "Ce fichier dépasse la limite de 1 Mio.")
}

pub(super) fn conflict() -> ProjectFileError {
    ProjectFileError::new(
        "conflict",
        "Ce fichier a été modifié depuis son ouverture. Rechargez-le avant d’enregistrer.",
    )
}

pub(super) fn exists() -> ProjectFileError {
    ProjectFileError::new("exists", "Un fichier ou un dossier porte déjà ce nom.")
}

pub(super) fn symlink_error() -> ProjectFileError {
    ProjectFileError::new(
        "symlink",
        "Les liens symboliques ne sont pas accessibles depuis l’explorateur.",
    )
}

pub(super) fn not_directory() -> ProjectFileError {
    ProjectFileError::new("notDirectory", "Le chemin demandé n’est pas un dossier.")
}

pub(super) fn not_file() -> ProjectFileError {
    ProjectFileError::new(
        "notFile",
        "Le chemin demandé n’est pas un fichier régulier.",
    )
}

pub(super) fn pasted_directory() -> ProjectFileError {
    ProjectFileError::new(
        "pastedDirectory",
        "Seuls des fichiers peuvent être collés, pas des dossiers.",
    )
}

pub(super) fn paste_too_large() -> ProjectFileError {
    ProjectFileError::new(
        "pasteTooLarge",
        "Les fichiers collés dans un projet SSH sont limités à 32 Mio.",
    )
}

pub(super) fn download_too_large() -> ProjectFileError {
    ProjectFileError::new(
        "downloadTooLarge",
        "Les fichiers téléchargés depuis un projet SSH sont limités à 8 Mio.",
    )
}
