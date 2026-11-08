use rusqlite::{params, Connection};

pub(crate) fn table_column_exists(
    conn: &Connection,
    table_name: &str,
    column_name: &str,
) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
        params![table_name, column_name],
        |row| row.get(0),
    )
}

pub(crate) fn validation_error(message: &str) -> rusqlite::Error {
    rusqlite::Error::InvalidParameterName(message.to_string())
}

pub(crate) fn random_id(conn: &Connection) -> rusqlite::Result<String> {
    conn.query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_present_and_absent_columns_and_tables() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE notes (id TEXT PRIMARY KEY)", [])
            .unwrap();

        assert!(table_column_exists(&conn, "notes", "id").unwrap());
        assert!(!table_column_exists(&conn, "notes", "missing").unwrap());
        assert!(!table_column_exists(&conn, "missing", "id").unwrap());
    }
}
