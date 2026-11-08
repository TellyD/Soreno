use crate::{
    bridge::{self, Bridge},
    channel::Context,
    files, identity,
    relay::{self, Endpoint},
    sessions,
    state::State,
    stop::Stop,
};
use std::{io, net::TcpListener, path::PathBuf, sync::Arc, thread};

pub struct Config {
    pub home: PathBuf,
    pub host: String,
    pub relay: Endpoint,
}

/// Serves the phones through the relay until `stop`.
pub fn run(config: Config, stop: Arc<Stop>) -> io::Result<()> {
    let directory = files::remote_dir(&config.home);
    let identity = identity::load_or_create(&directory)?;
    let sessions = sessions::roots(&config.home);
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let bridge = Arc::new(Bridge {
        sessions: sessions.clone(),
        token: files::hex(&files::random::<32>()?),
    });
    let context = Context {
        directory: directory.clone(),
        sessions,
        host: config.host.clone(),
        private: identity.private,
        bridge: listener.local_addr()?,
        token: bridge.token.clone(),
    };
    let state = State::new(
        directory,
        identity.id(),
        config.host,
        config.relay.url.clone(),
    )?;
    eprintln!("soreno-remote : serveur {}", identity.id());
    thread::scope(|scope| {
        let serving = stop.clone();
        scope.spawn(move || bridge::run(listener, bridge, serving));
        scope.spawn(|| state.keep(&stop));
        relay::run(&config.relay, &identity, &context, &state, &stop);
        stop.request();
    });
    Ok(())
}
