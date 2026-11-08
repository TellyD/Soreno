use super::*;
use crate::project_git::test_fixtures::{local_project, successful_stdout};
use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

struct TempRepository(std::path::PathBuf);

impl TempRepository {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "soreno-git-archive-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn git(&self, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(["-C", self.0.to_str().unwrap()])
            .args(args)
            .env("HOME", &self.0)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.0.join("global.config"))
            .output()
            .unwrap();
        successful_stdout(output, args)
    }

    fn install_signed_commit(&self) -> String {
        // Frozen fixture: renaming its author would change the hashes and void the signature.
        const BEFORE_BLOB: &str = "90be1f3056c4f471f977a28497b8d4b392c55a02";
        const AFTER_BLOB: &str = "294186e497a23bf3fbfde12aacc7f720f668fe9a";
        const PARENT: &str = "6eaf6c9b5f2500a6fc786761da3de598fe03cb0b";
        const SIGNED: &str = "4478bc61256df52715b63560d6cccfa3aab021c5";
        const PARENT_COMMIT: &str = "tree 976d0ec97ea997d1d84309bba278e3815a8aabac\nauthor Telaoi Test <test@telaoi.invalid> 1704067200 +0000\ncommitter Telaoi Test <test@telaoi.invalid> 1704067200 +0000\n\nbefore\n";
        const SIGNED_COMMIT: &str = "tree 5eeede0ea2bafa0564fdf571f7aa2ab3b7a383f4\nparent 6eaf6c9b5f2500a6fc786761da3de598fe03cb0b\nauthor Telaoi Test <test@telaoi.invalid> 1704153600 +0000\ncommitter Telaoi Test <test@telaoi.invalid> 1704153600 +0000\ngpgsig -----BEGIN SSH SIGNATURE-----\n U1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAg1x2+nNro4SB3hIGsV6ZPvO6HTf\n UZ1OP/HdCY1ECoJKUAAAADZ2l0AAAAAAAAAAZzaGE1MTIAAABTAAAAC3NzaC1lZDI1NTE5\n AAAAQIR4xAIfs1JbJXkFvczNyEYgin+gw0Ccy4lpKTqbmTcnMp8HQkgz8a/ntO5bDSbjo8\n o1mMxW/vEDL/ulY4MzdwM=\n -----END SSH SIGNATURE-----\n\nsigned\n";

        fs::write(self.0.join("file"), "before\n").unwrap();
        assert_eq!(self.git(&["hash-object", "-w", "file"]), BEFORE_BLOB);
        self.git(&[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("100644,{BEFORE_BLOB},file"),
        ]);
        assert_eq!(
            self.git(&["write-tree"]),
            "976d0ec97ea997d1d84309bba278e3815a8aabac"
        );
        fs::write(self.0.join(".git/parent.commit"), PARENT_COMMIT).unwrap();
        assert_eq!(
            self.git(&["hash-object", "-w", "-t", "commit", ".git/parent.commit"]),
            PARENT
        );

        fs::write(self.0.join("file"), "after\n").unwrap();
        assert_eq!(self.git(&["hash-object", "-w", "file"]), AFTER_BLOB);
        self.git(&[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("100644,{AFTER_BLOB},file"),
        ]);
        assert_eq!(
            self.git(&["write-tree"]),
            "5eeede0ea2bafa0564fdf571f7aa2ab3b7a383f4"
        );
        fs::write(self.0.join(".git/signed.commit"), SIGNED_COMMIT).unwrap();
        assert_eq!(
            self.git(&["hash-object", "-w", "-t", "commit", ".git/signed.commit"]),
            SIGNED
        );
        fs::write(
                self.0.join(".git/allowed-signers"),
                "validation@example.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINcdvpza6OEgd4SBrFemT7zuh031GdTj/x3QmNRAqCSl validation@example.invalid\n",
            )
            .unwrap();
        self.git(&["config", "gpg.format", "ssh"]);
        self.git(&[
            "config",
            "gpg.ssh.allowedSignersFile",
            self.0.join(".git/allowed-signers").to_str().unwrap(),
        ]);
        self.git(&[
            "config",
            "gpg.ssh.program",
            self.0.join(".git/crypto-must-not-run").to_str().unwrap(),
        ]);
        self.git(&["config", "log.showSignature", "true"]);
        self.git(&["update-ref", "HEAD", SIGNED]);
        SIGNED.into()
    }
}

impl Drop for TempRepository {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn archives_from_a_subdirectory_keep_root_paths_and_outside_files() {
    let repository = TempRepository::new();
    repository.git(&["init", "-q"]);
    repository.git(&["config", "user.name", "Soreno Test"]);
    repository.git(&["config", "user.email", "test@example.invalid"]);
    fs::create_dir(repository.0.join("nested")).unwrap();
    fs::write(repository.0.join("outside"), "before outside\n").unwrap();
    fs::write(repository.0.join("nested/inside"), "before inside\n").unwrap();
    repository.git(&["add", "-A"]);
    repository.git(&["commit", "-qm", "before"]);
    fs::write(repository.0.join("outside"), "after outside\n").unwrap();
    fs::write(repository.0.join("nested/inside"), "after inside\n").unwrap();
    repository.git(&["add", "-A"]);
    repository.git(&["commit", "-qm", "after"]);
    repository.git(&["config", "diff.relative", "true"]);
    let after = repository.git(&["rev-parse", "HEAD"]);
    let project = local_project(
        "archive-subdirectory",
        "Archive",
        &repository.0.join("nested"),
    );
    let paths = |archive: Archive| {
        let mut paths = archive
            .files
            .into_iter()
            .map(|entry| entry.file.path)
            .collect::<Vec<_>>();
        paths.sort();
        paths
    };

    assert_eq!(
        paths(read_archive(&project, &after).unwrap()),
        ["nested/inside", "outside"]
    );
}

#[test]
fn structured_logs_ignore_inherited_signature_display() {
    let repository = TempRepository::new();
    repository.git(&["init", "-q"]);
    let oid = repository.install_signed_commit();
    let project = local_project("signed-commit", "Signed commit", &repository.0);

    let history = crate::project_git::history::history(&project, None, 0, None).unwrap();
    assert_eq!(history.commits[0].oid, oid);
    let detail = crate::project_git::history::commit_detail(&project, &oid).unwrap();
    assert_eq!(
        detail.parent.as_deref(),
        Some("6eaf6c9b5f2500a6fc786761da3de598fe03cb0b")
    );
    assert_eq!(detail.files[0].path, "file");
    let comparison =
        crate::project_git::history::commit_comparison(&project, &oid, "file").unwrap();
    assert_eq!(comparison.before.text.as_deref(), Some("before\n"));
    assert_eq!(comparison.after.text.as_deref(), Some("after\n"));
}

#[test]
fn combined_diff_keeps_oids_modes_and_special_rename_paths() {
    let bytes = format!(
        ":100644 100755 {} {} R100\0old\tname\0new\nname\01\t2\t\0old\tname\0new\nname\0",
        "a".repeat(40),
        "b".repeat(40)
    );
    let files = parse_files(bytes.as_bytes()).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].file.path, "new\nname");
    assert_eq!(files[0].file.old_path.as_deref(), Some("old\tname"));
    assert_eq!(files[0].file.added, Some(1));
    assert_eq!(files[0].file.deleted, Some(2));
    assert_eq!(files[0].before.as_ref().unwrap().0, "100644");
    assert_eq!(files[0].after.as_ref().unwrap().0, "100755");
    assert!(parse_files(b":bad\0path\0").is_err());
}

#[test]
fn raw_non_unicode_paths_are_not_confused_with_escaped_display_paths() {
    let mut bytes =
        format!(":000000 100644 {} {} A\0", "0".repeat(40), "b".repeat(40)).into_bytes();
    bytes.extend_from_slice(b"raw-\xff\01\t0\traw-\xff\0");
    let files = parse_files(&bytes).unwrap();
    assert!(!files[0].representable);
    assert!(files[0].before.is_none());
}
