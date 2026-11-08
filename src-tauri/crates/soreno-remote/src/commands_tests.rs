use super::*;
use crate::testing::TempDir;
use soreno_mobile_protocol::{decode_key, device_id, generate_keypair};

fn args(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| arg.to_string()).collect()
}

#[test]
fn serve_takes_the_relay_and_its_key() {
    let key = "A".repeat(43);
    let endpoint = parse_serve(&args(&[
        "--relay",
        "ws://192.0.2.10:8790",
        "--relay-key",
        &key,
    ]))
    .unwrap();
    assert_eq!(endpoint.authority, "192.0.2.10:8790");
    assert_eq!(endpoint.url, "ws://192.0.2.10:8790/relay/server");
    assert_eq!(endpoint.key, [0u8; 32]);
    let same = parse_serve(&args(&[
        "--relay-key",
        &key,
        "--relay",
        "ws://192.0.2.10:8790/relay/server",
    ]))
    .unwrap();
    assert_eq!(same, endpoint);
    for refused in [
        &["--relay", "ws://192.0.2.10:8790"][..],
        &["--relay", "wss://relais:443", "--relay-key", &key],
        &["--relay", "http://relais:8790", "--relay-key", &key],
        &["--relay", "ws://relais", "--relay-key", &key],
        &["--relay", "ws://relais:8790/autre", "--relay-key", &key],
        &["--relay", "ws://relais:8790", "--relay-key", "court"],
        &[
            "--relay",
            "ws://a:1",
            "--relay",
            "ws://b:2",
            "--relay-key",
            &key,
        ],
        &["--listen", "127.0.0.1:9000"],
        &[
            "--relay",
            "ws://relais:8790",
            "--relay-key",
            &key,
            "--role",
            "principal",
        ],
    ] {
        assert!(parse_serve(&args(refused)).is_err(), "{refused:?}");
    }
}

#[test]
fn pair_access_and_revoke_speak_json() {
    let temp = TempDir::new();
    let home = temp.path();
    let line: serde_json::Value = serde_json::from_str(&pair(home).unwrap()).unwrap();
    let server = line["server"].as_str().unwrap().to_owned();
    assert!(decode_key(&server).is_some());
    assert_eq!(line["secret"].as_str().unwrap().len(), 43);
    let id = line["id"].as_str().unwrap().to_owned();
    assert!(access::valid_device_id(&id));
    let expires_at = line["expiresAt"].as_u64().unwrap();
    assert!(expires_at > files::now_ms());
    let expires_in = line["expiresInMs"].as_u64().unwrap();
    assert!(expires_in > 0 && expires_in <= access::PAIRING_LIFETIME_MS);

    let listed: serde_json::Value = serde_json::from_str(&access(home).unwrap()).unwrap();
    assert_eq!(
        listed,
        serde_json::json!({
            "server": server, "devices": [],
            "pairings": [{"id": id, "expiresAt": expires_at}], "used": [],
        })
    );

    let phone = generate_keypair().unwrap().public;
    let directory = files::remote_dir(home);
    access::admit(
        &directory,
        &phone,
        "Android · Chrome",
        line["secret"].as_str(),
    )
    .unwrap()
    .unwrap();
    let listed: serde_json::Value = serde_json::from_str(&access(home).unwrap()).unwrap();
    assert_eq!(listed["pairings"], serde_json::json!([]));
    assert_eq!(listed["used"], serde_json::json!([id]));
    let device = &listed["devices"][0];
    assert_eq!(device["id"], device_id(&phone));
    assert_eq!(device["label"], "Android · Chrome");
    assert!(device["pairedAt"].as_u64().is_some());
    assert!(device["lastSeenAt"].as_u64().is_some());
    assert!(device.get("public").is_none());

    assert_eq!(revoke(home, "pas-un-id").unwrap(), 2);
    assert_eq!(revoke(home, "0000000000000000").unwrap(), 0);
    assert_eq!(revoke(home, &device_id(&phone)).unwrap(), 0);
    let listed: serde_json::Value = serde_json::from_str(&access(home).unwrap()).unwrap();
    assert_eq!(listed["devices"], serde_json::json!([]));
    // The identity stays the same from one command to the next.
    assert_eq!(listed["server"], server.as_str());
}
