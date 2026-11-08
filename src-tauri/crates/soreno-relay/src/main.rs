const USAGE: &str = "usage : soreno-relay serve --phones <adresse:port|unix:chemin> --servers <adresse:port> --origin <https://hôte> --key <fichier> | soreno-relay keygen <fichier> | soreno-relay public-key <fichier> | soreno-relay --version";

#[cfg(target_os = "linux")]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("--version") if args.len() == 1 => {
            println!("soreno-relay {}", env!("CARGO_PKG_VERSION"));
            0
        }
        Some("keygen") if args.len() == 2 => linux::keygen(&args[1]),
        Some("public-key") if args.len() == 2 => linux::public_key(&args[1]),
        Some("serve") => linux::serve(&args[1..]),
        _ => {
            eprintln!("{USAGE}");
            2
        }
    };
    std::process::exit(code);
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("soreno-relay ne fonctionne que sous Linux.\n{USAGE}");
    std::process::exit(2);
}

#[cfg(target_os = "linux")]
mod linux {
    use super::USAGE;
    use soreno_mobile_protocol::encode_key;
    use soreno_relay::{
        http::{self, Side},
        keys,
        net::Listener,
        relay::Relay,
        stop::Stop,
    };
    use std::{io, net::TcpListener, path::Path, sync::Arc, thread};

    pub fn keygen(path: &str) -> i32 {
        match keys::generate(Path::new(path)) {
            Ok(public) => {
                println!("{}", encode_key(&public));
                0
            }
            Err(error) => {
                eprintln!("soreno-relay : clé {path} : {error}");
                1
            }
        }
    }

    pub fn public_key(path: &str) -> i32 {
        match keys::read(Path::new(path)) {
            Ok(private) => {
                println!("{}", encode_key(&keys::public_key(&private)));
                0
            }
            Err(error) => {
                eprintln!("soreno-relay : clé {path} : {error}");
                1
            }
        }
    }

    pub fn serve(args: &[String]) -> i32 {
        let (mut phones, mut servers, mut origin, mut key) = (None, None, None, None);
        let mut rest = args.iter();
        while let Some(flag) = rest.next() {
            let slot = match flag.as_str() {
                "--phones" => &mut phones,
                "--servers" => &mut servers,
                "--origin" => &mut origin,
                "--key" => &mut key,
                _ => return usage(),
            };
            match rest.next() {
                Some(value) if slot.is_none() => *slot = Some(value.clone()),
                _ => return usage(),
            }
        }
        let (Some(phones), Some(servers), Some(origin), Some(key)) = (phones, servers, origin, key)
        else {
            return usage();
        };
        if !valid_origin(&origin) {
            eprintln!(
                "soreno-relay : origine invalide « {origin} » (attendu : https://hôte[:port])"
            );
            return 2;
        }
        let private = match keys::read(Path::new(&key)) {
            Ok(private) => private,
            Err(error) => {
                eprintln!("soreno-relay : clé {key} : {error}");
                return 1;
            }
        };
        let bind = |address: &str, listener: io::Result<Listener>| {
            listener.map_err(|error| {
                eprintln!("soreno-relay : écoute sur {address} : {error}");
            })
        };
        let (Ok(phones_listener), Ok(servers_listener)) = (
            bind(&phones, Listener::bind(&phones)),
            bind(&servers, TcpListener::bind(&servers).map(Listener::Tcp)),
        ) else {
            return 1;
        };
        let stop = match Stop::new().and_then(|stop| stop.on_signals().map(|()| stop)) {
            Ok(stop) => Arc::new(stop),
            Err(error) => {
                eprintln!("soreno-relay : signaux : {error}");
                return 1;
            }
        };
        let relay = Arc::new(Relay::new(private, origin));
        eprintln!(
            "soreno-relay {} : téléphones sur {phones}, serveurs sur {servers}, clé publique {}",
            env!("CARGO_PKG_VERSION"),
            encode_key(&keys::public_key(&private))
        );
        let servers_thread = {
            let (relay, stop) = (relay.clone(), stop.clone());
            thread::spawn(move || http::run(servers_listener, Side::Servers, relay, stop))
        };
        http::run(phones_listener, Side::Phones, relay, stop);
        let _ = servers_thread.join();
        eprintln!("soreno-relay : arrêté");
        0
    }

    fn usage() -> i32 {
        eprintln!("{USAGE}");
        2
    }

    /// Exactly what browsers send as `Origin`: a scheme, a host and maybe a port.
    fn valid_origin(origin: &str) -> bool {
        let host = origin
            .strip_prefix("https://")
            .or_else(|| origin.strip_prefix("http://"));
        host.is_some_and(|host| {
            !host.is_empty()
                && host
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'))
        })
    }
}
