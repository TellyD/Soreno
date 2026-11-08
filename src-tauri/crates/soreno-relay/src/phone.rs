use crate::{
    mailbox::Pop,
    net::Stream,
    relay::{Relay, INVALID, OFFLINE, STOPPING, TOO_MANY},
    stop::Stop,
    wire::{Fault, Wire, SEND_MESSAGES},
};
use soreno_mobile_protocol::{decode_key, PHONE_FRAME_LIMIT};
use std::net::IpAddr;

/// One phone's channel to `server`, its Noise messages going through untouched both ways.
pub fn serve(
    stream: Stream,
    rest: Vec<u8>,
    relay: &Relay,
    server: &str,
    address: IpAddr,
    stop: &Stop,
) {
    let Some(mut wire) = Wire::accept(stream, rest, PHONE_FRAME_LIMIT) else {
        return;
    };
    if decode_key(server).is_none() {
        wire.finish(INVALID);
        return;
    }
    let Some(_admission) = relay.admit(address, server) else {
        eprintln!("soreno-relay : trop de connexions depuis {address}");
        wire.finish(TOO_MANY);
        return;
    };
    let Some(link) = relay.link(server) else {
        wire.finish(OFFLINE);
        return;
    };
    let channel = match link.open() {
        Ok(channel) => channel,
        Err(code) => {
            wire.finish(code);
            return;
        }
    };
    let code = 'phone: loop {
        if stop.requested() {
            break Some(STOPPING);
        }
        let (messages, fault) = wire.receive();
        if !messages
            .into_iter()
            .all(|message| link.send(&channel, message))
        {
            break Some(channel.code());
        }
        match fault {
            Some(Fault::Invalid) => break Some(INVALID),
            Some(Fault::Gone) => break None,
            None => {}
        }
        // A slow phone leaves the server's messages queued, which ends the channel once full.
        let (mut sent, mut idle) = (0, false);
        while sent < SEND_MESSAGES && wire.flushed() {
            match channel.down.pop() {
                Pop::Item(message) => {
                    if !wire.send(message) {
                        break 'phone None;
                    }
                    sent += 1;
                }
                Pop::Empty => {
                    idle = true;
                    break;
                }
                Pop::Closed => break 'phone Some(channel.code()),
            }
        }
        if sent < SEND_MESSAGES {
            let fds = [stop.fd(), channel.down.fd()];
            wire.wait(if idle { &fds } else { &fds[..1] }, None);
        }
    };
    link.release(&channel);
    match code {
        Some(code) => wire.finish(code),
        None => wire.close(),
    }
}
