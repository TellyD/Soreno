use super::super::tests::database;
use super::super::{
    create_comment, create_issue, default_team_id, delete_issue, KanbanIssueCreateInput,
};
use super::*;
use crate::agent_sessions::tests::unique_temp_path;

const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest";

fn temp_directory(name: &str) -> PathBuf {
    unique_temp_path(&format!("soreno-kanban-images-{name}"))
}

#[test]
fn uploads_are_typed_by_their_bytes_and_stored_under_a_random_name() {
    let db = database();
    let directory = temp_directory("upload");
    let path = save_upload(&db, &directory, PNG).unwrap();
    let name = path.file_name().unwrap().to_str().unwrap().to_owned();
    assert_eq!(name_extension(&name), Some("png"));
    assert_eq!(std::fs::read(&path).unwrap(), PNG);
    let (content_type, size): (String, i64) = db
        .query_row(
            "SELECT content_type, size FROM kanban_images WHERE file_name=?1 AND issue_id IS NULL",
            [&name],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (content_type.as_str(), size),
        ("image/png", PNG.len() as i64)
    );
    assert_eq!(
        read_prompt_image(&directory, &name).unwrap(),
        ("png".to_owned(), PNG.to_vec())
    );

    for bytes in [
        &b""[..],
        b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
        b"RIFF0000WAVE",
    ] {
        assert_eq!(
            save_upload(&db, &directory, bytes).unwrap_err(),
            IMAGE_TYPE_MESSAGE
        );
    }
    let mut large = PNG.to_vec();
    large.resize(MAX_IMAGE_BYTES + 1, 0);
    assert_eq!(
        save_upload(&db, &directory, &large).unwrap_err(),
        IMAGE_TOO_LARGE_MESSAGE
    );
    assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);

    remove_files(&directory, &[name.clone()]);
    assert!(!path.exists());
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn only_names_soreno_gives_reach_the_images_directory() {
    let directory = Path::new("/images");
    let valid = "0123456789abcdef0123456789abcdef.webp";
    assert_eq!(image_path(directory, valid).unwrap(), directory.join(valid));
    for name in [
        "../0123456789abcdef0123456789abcdef.png",
        "0123456789ABCDEF0123456789ABCDEF.png",
        "0123456789abcdef0123456789abcde.png",
        "0123456789abcdef0123456789abcdef.svg",
        "0123456789abcdef0123456789abcdef.png.png",
        "0123456789abcdef0123456789abcdef",
    ] {
        assert!(image_path(directory, name).is_err(), "{name}");
        assert!(read_prompt_image(directory, name).is_err(), "{name}");
    }
}

fn upload(db: &Connection, directory: &Path) -> String {
    let path = save_upload(db, directory, PNG).unwrap();
    path.file_name().unwrap().to_str().unwrap().to_owned()
}

fn issue_with(db: &Connection, description: &str) -> String {
    create_issue(
        db,
        KanbanIssueCreateInput {
            team_id: default_team_id(db).unwrap(),
            title: "Issue".into(),
            description: Some(description.into()),
            ..KanbanIssueCreateInput::default()
        },
    )
    .unwrap()
    .id
}

fn owner(db: &Connection, name: &str) -> Option<String> {
    db.query_row(
        "SELECT issue_id FROM kanban_images WHERE file_name=?1",
        [name],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn deleting_an_issue_hands_its_images_to_the_issues_still_showing_them() {
    let db = database();
    let directory = temp_directory("shared");
    let in_comment = upload(&db, &directory);
    let in_description = upload(&db, &directory);
    let own = upload(&db, &directory);
    let first = issue_with(
        &db,
        &format!("![]({in_comment}) ![]({in_description}) ![]({own})"),
    );
    create_comment(&db, &first, &format!("Encore ![]({own})")).unwrap();
    let commenting = issue_with(&db, "Copie");
    create_comment(&db, &commenting, &format!("![]({in_comment})")).unwrap();
    let describing = issue_with(&db, &format!("![]({in_description})"));
    assert_eq!(owner(&db, &in_comment).as_deref(), Some(first.as_str()));

    let files = delete_issue(&db, &first).unwrap();
    remove_files(&directory, &files);
    assert_eq!(files, [own.clone()]);
    assert!(!directory.join(&own).exists());
    assert_eq!(owner(&db, &in_comment), Some(commenting.clone()));
    assert_eq!(owner(&db, &in_description), Some(describing));
    assert!(directory.join(&in_comment).exists());
    assert!(directory.join(&in_description).exists());

    let files = delete_issue(&db, &commenting).unwrap();
    remove_files(&directory, &files);
    assert_eq!(files, [in_comment.clone()]);
    assert!(!directory.join(&in_comment).exists());
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn only_unclaimed_uploads_older_than_a_day_are_purged() {
    let mut db = database();
    let directory = temp_directory("purge");
    let abandoned = upload(&db, &directory);
    let recent = upload(&db, &directory);
    let claimed = upload(&db, &directory);
    issue_with(&db, &format!("![]({claimed})"));
    db.execute(
        "UPDATE kanban_images SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-25 hours')
        WHERE file_name IN (?1, ?2)",
        [&abandoned, &claimed],
    )
    .unwrap();

    purge_abandoned_uploads(&mut db, &directory).unwrap();
    let remaining: Vec<String> = db
        .prepare("SELECT file_name FROM kanban_images ORDER BY file_name")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let mut expected = vec![recent.clone(), claimed.clone()];
    expected.sort();
    assert_eq!(remaining, expected);
    assert!(!directory.join(&abandoned).exists());
    assert!(directory.join(&recent).exists());
    assert!(directory.join(&claimed).exists());
    std::fs::remove_dir_all(directory).unwrap();
}

fn age(path: &Path) {
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(25 * 60 * 60))
        .unwrap();
}

#[test]
fn old_image_files_without_a_row_are_purged() {
    let mut db = database();
    let directory = temp_directory("orphans");
    let recorded = upload(&db, &directory);
    age(&directory.join(&recorded));
    let orphan = format!("{}.png", "a".repeat(32));
    let recent_orphan = format!("{}.webp", "b".repeat(32));
    let foreign = "notes.png".to_owned();
    for name in [&orphan, &recent_orphan, &foreign] {
        std::fs::write(directory.join(name), PNG).unwrap();
    }
    age(&directory.join(&orphan));
    age(&directory.join(&foreign));
    let folder = directory.join(format!("{}.gif", "c".repeat(32)));
    std::fs::create_dir(&folder).unwrap();

    purge_abandoned_uploads(&mut db, &directory).unwrap();
    assert!(!directory.join(&orphan).exists());
    assert!(directory.join(&recent_orphan).exists());
    assert!(directory.join(&recorded).exists());
    assert!(directory.join(&foreign).exists());
    assert!(folder.is_dir());
    std::fs::remove_dir_all(&directory).unwrap();

    purge_abandoned_uploads(&mut db, &directory).unwrap();
}
