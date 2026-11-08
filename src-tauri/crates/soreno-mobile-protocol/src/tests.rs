use super::*;

/// Runs an IK handshake; the responder learns the initiator's static key.
fn handshake(
    initiator_keys: &Keypair,
    responder_keys: &Keypair,
    prologue_initiator: &[u8],
    prologue_responder: &[u8],
) -> Result<(TransportState, TransportState, Vec<u8>), Error> {
    let mut initiator = initiator(
        &initiator_keys.private,
        &responder_keys.public,
        prologue_initiator,
    )?;
    let mut responder = responder(&responder_keys.private, prologue_responder)?;
    let mut buffer = vec![0u8; NOISE_MESSAGE_LIMIT];
    let mut payload = vec![0u8; NOISE_MESSAGE_LIMIT];
    let length = initiator.write_message(b"bonjour", &mut buffer)?;
    let read = responder.read_message(&buffer[..length], &mut payload)?;
    assert_eq!(&payload[..read], b"bonjour");
    let length = responder.write_message(b"ok", &mut buffer)?;
    let read = initiator.read_message(&buffer[..length], &mut payload)?;
    assert_eq!(&payload[..read], b"ok");
    let remote = responder.get_remote_static().unwrap().to_vec();
    Ok((
        initiator.into_transport_mode()?,
        responder.into_transport_mode()?,
        remote,
    ))
}

#[test]
fn the_responder_learns_the_phone_key_and_both_sides_talk() {
    let phone = generate_keypair().unwrap();
    let server = generate_keypair().unwrap();
    let (mut phone_side, mut server_side, remote) =
        handshake(&phone, &server, PHONE_PROLOGUE, PHONE_PROLOGUE).unwrap();
    assert_eq!(remote, phone.public);
    let sealed = seal(&mut phone_side, b"liste").unwrap();
    assert_eq!(open(&mut server_side, &sealed).unwrap(), b"liste");
    let reply = seal(&mut server_side, b"sessions").unwrap();
    assert_eq!(open(&mut phone_side, &reply).unwrap(), b"sessions");
    // A replayed or altered message is refused.
    assert!(open(&mut server_side, &sealed).is_err());
}

#[test]
fn another_server_key_or_protocol_cannot_complete_the_handshake() {
    let phone = generate_keypair().unwrap();
    let server = generate_keypair().unwrap();
    let impostor = generate_keypair().unwrap();
    let mut initiator = initiator(&phone.private, &server.public, PHONE_PROLOGUE).unwrap();
    let mut wrong = responder(&impostor.private, PHONE_PROLOGUE).unwrap();
    let mut buffer = vec![0u8; NOISE_MESSAGE_LIMIT];
    let mut payload = vec![0u8; NOISE_MESSAGE_LIMIT];
    let length = initiator.write_message(b"", &mut buffer).unwrap();
    assert!(wrong.read_message(&buffer[..length], &mut payload).is_err());
    assert!(handshake(&phone, &server, PHONE_PROLOGUE, RELAY_PROLOGUE).is_err());
}

#[test]
fn keys_round_trip_through_their_text_form() {
    let keys = generate_keypair().unwrap();
    let text = encode_key(&keys.public);
    assert_eq!(text.len(), 43);
    assert_eq!(decode_key(&text), Some(keys.public));
    for refused in [
        "",
        "court",
        &format!("{text}A"),
        &text.replace(&text[..1], "+"),
    ] {
        assert_eq!(decode_key(refused), None, "{refused}");
    }
    assert_eq!(device_id(&[0xab; KEY_LENGTH]), "abababababababab");
}

#[test]
fn messages_are_chunked_and_reassembled() {
    let mut reassembly = Reassembly::default();
    assert_eq!(chunks(b""), vec![vec![0]]);
    assert_eq!(reassembly.push(&[0]), Ok(Some(Vec::new())));
    let message: Vec<u8> = (0..CHUNK_LIMIT * 2 + 10).map(|i| i as u8).collect();
    let parts = chunks(&message);
    assert_eq!(parts.len(), 3);
    assert!(parts.iter().all(|part| part.len() <= CHUNK_LIMIT + 1));
    assert_eq!(reassembly.push(&parts[0]), Ok(None));
    assert_eq!(reassembly.push(&parts[1]), Ok(None));
    assert_eq!(reassembly.push(&parts[2]), Ok(Some(message)));
    assert_eq!(reassembly.push(&[]), Err(ChunkError::Malformed));
    assert_eq!(reassembly.push(&[2, 1]), Err(ChunkError::Malformed));
    let huge = vec![1u8; CHUNK_LIMIT + 1];
    let mut flooded = Reassembly::default();
    let mut result = Ok(None);
    for _ in 0..=MESSAGE_LIMIT / CHUNK_LIMIT {
        result = flooded.push(&huge);
    }
    assert_eq!(result, Err(ChunkError::TooLong));
}

#[test]
fn a_full_phone_chunk_fits_in_one_relay_frame_and_one_link_message() {
    let phone = generate_keypair().unwrap();
    let server = generate_keypair().unwrap();
    let (mut phone_side, _, _) =
        handshake(&phone, &server, PHONE_PROLOGUE, PHONE_PROLOGUE).unwrap();
    let chunk = &chunks(&vec![7u8; CHUNK_LIMIT])[0];
    let sealed = seal(&mut phone_side, chunk).unwrap();
    assert_eq!(sealed.len(), PHONE_FRAME_LIMIT);
    let frame = Frame::Data(9, sealed).encode();
    assert!(frame.len() + TAG_LENGTH <= NOISE_MESSAGE_LIMIT);
    assert!(matches!(Frame::decode(&frame), Some(Frame::Data(9, _))));
}

#[test]
fn relay_frames_round_trip_and_refuse_garbage() {
    for frame in [
        Frame::Open(1),
        Frame::Data(u32::MAX, vec![1, 2, 3]),
        Frame::Close(7),
    ] {
        assert_eq!(Frame::decode(&frame.encode()), Some(frame));
    }
    for garbage in [
        &[][..],
        &[1, 0, 0],
        &[1, 0, 0, 0, 1, 9],
        &[4, 0, 0, 0, 1],
        &[3, 0, 0, 0, 1, 0],
    ] {
        assert_eq!(Frame::decode(garbage), None, "{garbage:?}");
    }
    let mut oversized = Frame::Data(1, Vec::new()).encode();
    oversized.resize(5 + PHONE_FRAME_LIMIT + 1, 0);
    assert_eq!(Frame::decode(&oversized), None);
}
