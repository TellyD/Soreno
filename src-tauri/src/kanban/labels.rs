use super::{compare_names, new_id, require_team, sql, KanbanLabel, Result};
use rusqlite::{Connection, Row};

const LABEL_NAME_LIMIT: usize = 255;
const LABEL_PALETTE: [&str; 8] = [
    "#5e6ad2", "#26b5ce", "#4cb782", "#f2c94c", "#f2994a", "#eb5757", "#bb87fc", "#95a2b3",
];
const LABEL_NAME_MESSAGE: &str =
    "[Kanban/invalidLabelName] Nom du label vide ou trop long (255 caractères maximum).";

pub(super) fn team_labels(db: &Connection, team_id: &str) -> Result<Vec<KanbanLabel>> {
    let mut labels = db
        .prepare("SELECT id, name, color FROM kanban_labels WHERE team_id=?1")
        .map_err(sql)?
        .query_map([team_id], label_row)
        .map_err(sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sql)?;
    labels.sort_by(|left, right| compare_names(&left.name, &right.name));
    Ok(labels)
}

fn label_row(row: &Row<'_>) -> rusqlite::Result<KanbanLabel> {
    Ok(KanbanLabel {
        id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
    })
}

pub(crate) fn required_label_name(name: &str) -> Result<&str> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > LABEL_NAME_LIMIT || name.contains('\0') {
        return Err(LABEL_NAME_MESSAGE.into());
    }
    Ok(name)
}

/// Reuses a label of the same name, ignoring case, instead of creating a duplicate.
pub(crate) fn create_label(db: &Connection, team_id: &str, name: &str) -> Result<KanbanLabel> {
    let name = required_label_name(name)?;
    require_team(db, team_id)?;
    let labels = team_labels(db, team_id)?;
    let folded = name.to_lowercase();
    if let Some(label) = labels
        .iter()
        .find(|label| label.name.to_lowercase() == folded)
    {
        return Ok(label.clone());
    }
    let label = KanbanLabel {
        id: new_id(db)?,
        name: name.into(),
        color: LABEL_PALETTE[labels.len() % LABEL_PALETTE.len()].into(),
    };
    db.execute(
        "INSERT INTO kanban_labels(id, team_id, name, color) VALUES (?1, ?2, ?3, ?4)",
        [&label.id, team_id, &label.name, &label.color],
    )
    .map_err(sql)?;
    Ok(label)
}
