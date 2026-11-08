use super::*;
use crate::testing::TempDir;
use soreno_mobile_protocol::generate_keypair;
use std::os::unix::fs::PermissionsExt;

fn phone() -> Key {
    generate_keypair().unwrap().public
}

#[test]
fn a_secret_pairs_one_device_once() {
    let temp = TempDir::new();
    let directory = temp.path();
    let pairing = pair(directory).unwrap();
    assert_eq!(pairing.secret.len(), 43);
    assert!(valid_device_id(&pairing.id));
    let stored = read(directory).unwrap();
    assert_eq!(stored.pairings[0].hash, hash(&pairing.secret));
    assert!(!fs::read_to_string(directory.join(FILE))
        .unwrap()
        .contains(&pairing.secret));

    let first = phone();
    let admitted = admit(
        directory,
        &first,
        "iPhone\u{7} · Safari",
        Some(&pairing.secret),
    );
    assert_eq!(admitted.unwrap(), Ok(()));
    let access = read(directory).unwrap();
    assert!(access.pairings.is_empty());
    assert_eq!(access.devices.len(), 1);
    let device = &access.devices[0];
    assert_eq!(device.id, device_id(&first));
    assert_eq!(device.public, encode_key(&first));
    assert_eq!(device.label, "iPhone · Safari");
    assert_eq!(device.last_seen_at, Some(device.paired_at));

    let second = phone();
    let reused = admit(directory, &second, "", Some(&pairing.secret));
    assert_eq!(reused.unwrap(), Err(Refusal::Pairing));
    assert_eq!(
        admit(directory, &second, "", None).unwrap(),
        Err(Refusal::Unpaired)
    );
    // Known: the secret no longer matters.
    assert_eq!(
        admit(directory, &first, "", Some("nimporte")).unwrap(),
        Ok(())
    );
    let mode = fs::metadata(directory.join(FILE))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn a_known_device_spends_a_new_secret_too() {
    let temp = TempDir::new();
    let directory = temp.path();
    let known = phone();
    let first = pair(directory).unwrap();
    admit(directory, &known, "", Some(&first.secret))
        .unwrap()
        .unwrap();
    let again = pair(directory).unwrap();
    assert_eq!(
        admit(directory, &known, "", Some(&again.secret)).unwrap(),
        Ok(())
    );
    let access = read(directory).unwrap();
    assert!(access.pairings.is_empty());
    let used: Vec<_> = access.used.iter().map(|used| used.id.as_str()).collect();
    assert_eq!(used, [first.id.as_str(), again.id.as_str()]);
    assert_eq!(access.used[1].expires_at, again.expires_at);
    let stranger = phone();
    assert_eq!(
        admit(directory, &stranger, "", Some(&again.secret)).unwrap(),
        Err(Refusal::Pairing)
    );
    assert_eq!(read(directory).unwrap().devices.len(), 1);
}

#[test]
fn spent_pairings_are_forgotten_once_expired() {
    let temp = TempDir::new();
    let directory = temp.path();
    let now = files::now_ms();
    let spent = |id: &str, expires_at| UsedPairing {
        id: id.into(),
        used_at: now - 1,
        expires_at,
    };
    let access = Access {
        used: vec![
            spent("0000000000000001", now - 1),
            spent("0000000000000002", now + 60_000),
        ],
        ..Access::default()
    };
    files::write_atomically(directory, FILE, &serde_json::to_vec(&access).unwrap()).unwrap();
    pair(directory).unwrap();
    let used = read(directory).unwrap().used;
    assert_eq!(used, [spent("0000000000000002", now + 60_000)]);
}

#[test]
fn an_expired_or_unknown_secret_does_not_pair() {
    let temp = TempDir::new();
    let directory = temp.path();
    let expired = "secret-perime";
    let access = Access {
        devices: Vec::new(),
        pairings: vec![Pairing {
            id: "0011223344556677".into(),
            hash: hash(expired),
            expires_at: files::now_ms() - 1,
        }],
        used: Vec::new(),
    };
    files::write_atomically(directory, FILE, &serde_json::to_vec(&access).unwrap()).unwrap();
    let key = phone();
    assert_eq!(
        admit(directory, &key, "", Some(expired)).unwrap(),
        Err(Refusal::Pairing)
    );
    assert!(read(directory).unwrap().pairings.is_empty());
    pair(directory).unwrap();
    assert_eq!(
        admit(directory, &key, "", Some("inconnu")).unwrap(),
        Err(Refusal::Pairing)
    );
    assert!(read(directory).unwrap().devices.is_empty());
    assert_eq!(read(directory).unwrap().pairings.len(), 1);
}

#[test]
fn at_most_eight_pairings_wait() {
    let temp = TempDir::new();
    let first = pair(temp.path()).unwrap();
    for _ in 0..PENDING_PAIRINGS {
        pair(temp.path()).unwrap();
    }
    let pairings = read(temp.path()).unwrap().pairings;
    assert_eq!(pairings.len(), PENDING_PAIRINGS);
    assert!(pairings.iter().all(|pairing| pairing.id != first.id));
}

#[test]
fn revoking_removes_the_device_and_the_watch_notices() {
    let temp = TempDir::new();
    let directory = temp.path();
    let pairing = pair(directory).unwrap();
    let key = phone();
    admit(directory, &key, "", Some(&pairing.secret))
        .unwrap()
        .unwrap();
    let mut watch = Watch::new(directory, &key);
    assert!(watch.allowed());
    assert!(!revoke(directory, "ffffffffffffffff").unwrap());
    assert!(watch.allowed());
    assert!(revoke(directory, &device_id(&key)).unwrap());
    assert!(!watch.allowed());
    assert_eq!(
        admit(directory, &key, "", None).unwrap(),
        Err(Refusal::Unpaired)
    );
}

#[test]
fn labels_are_printable_and_short() {
    assert_eq!(clean_label("  Android\n·\tChrome  "), "Android · Chrome");
    assert_eq!(clean_label("\u{1b}[31m"), "[31m");
    assert_eq!(clean_label(""), DEFAULT_LABEL);
    assert_eq!(clean_label(&"é".repeat(60)).chars().count(), LABEL_LIMIT);
    assert!(valid_device_id("0123456789abcdef"));
    for id in [
        "0123456789ABCDEF",
        "0123",
        "0123456789abcdeg",
        "../../etc/passwd",
    ] {
        assert!(!valid_device_id(id), "{id}");
    }
}
