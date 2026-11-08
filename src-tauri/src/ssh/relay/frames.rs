use super::{Result, HEADER_LIMIT};
use std::io::{BufRead, Read};

pub(super) fn read_header(reader: &mut impl BufRead) -> Result<Vec<u8>> {
    let mut header = Vec::new();
    let read = reader
        .take((HEADER_LIMIT + 1) as u64)
        .read_until(b'\n', &mut header)
        .map_err(|error| format!("Lecture du relais SSH impossible : {error}"))?;
    if read == 0 {
        return Err("Connexion SSH interrompue.".into());
    }
    if header.len() > HEADER_LIMIT || !header.ends_with(b"\n") {
        return Err("En-tête du relais SSH invalide.".into());
    }
    header.pop();
    Ok(header)
}

pub(super) fn parse_header(header: &[u8]) -> Result<(u64, u8, usize, usize, bool)> {
    let header = std::str::from_utf8(header).map_err(|_| "En-tête SSH non UTF-8.")?;
    let fields = header.split(' ').collect::<Vec<_>>();
    if fields.len() != 6
        || fields[0] != "S"
        || fields[1..]
            .iter()
            .any(|field| field.is_empty() || !field.bytes().all(|byte| byte.is_ascii_digit()))
        || !matches!(fields[5], "0" | "1")
    {
        return Err("En-tête du relais SSH invalide.".into());
    }
    let id = fields[1]
        .parse()
        .map_err(|_| "Identifiant SSH invalide.".to_string())?;
    let status = fields[2]
        .parse()
        .map_err(|_| "Statut SSH invalide.".to_string())?;
    let stdout_len = fields[3]
        .parse()
        .map_err(|_| "Taille de sortie SSH invalide.".to_string())?;
    let stderr_len = fields[4]
        .parse()
        .map_err(|_| "Taille d’erreur SSH invalide.".to_string())?;
    Ok((id, status, stdout_len, stderr_len, fields[5] == "1"))
}

pub(super) fn parse_cancel_header(header: &[u8]) -> Result<u64> {
    let header = std::str::from_utf8(header).map_err(|_| "En-tête SSH non UTF-8.")?;
    let id = header
        .strip_prefix("X ")
        .filter(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()))
        .ok_or_else(|| {
            format!(
                "En-tête d’annulation SSH invalide : {:?}.",
                String::from_utf8_lossy(header.as_bytes())
            )
        })?;
    id.parse()
        .map_err(|_| "Identifiant d’annulation SSH invalide.".into())
}
