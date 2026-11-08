#[cfg(target_os = "linux")]
mod access;
#[cfg(target_os = "linux")]
mod bridge;
#[cfg(target_os = "linux")]
mod channel;
#[cfg(target_os = "linux")]
mod commands;
#[cfg(target_os = "linux")]
mod conversation;
#[cfg(target_os = "linux")]
mod dtach;
#[cfg(target_os = "linux")]
mod files;
#[cfg(target_os = "linux")]
mod history;
#[cfg(target_os = "linux")]
mod identity;
#[cfg(target_os = "linux")]
mod images;
#[cfg(all(test, target_os = "linux", target_arch = "x86_64"))]
mod integration_tests;
#[cfg(target_os = "linux")]
mod mailbox;
#[cfg(target_os = "linux")]
mod peer;
#[cfg(target_os = "linux")]
mod relay;
#[cfg(target_os = "linux")]
mod service;
#[cfg(target_os = "linux")]
mod sessions;
#[cfg(target_os = "linux")]
mod state;
#[cfg(target_os = "linux")]
mod stop;
#[cfg(all(test, target_os = "linux"))]
mod testing;
#[cfg(target_os = "linux")]
mod wire;

const USAGE: &str = "usage : soreno-remote serve --relay ws://<hôte>:<port> --relay-key <clé> | soreno-remote pair | soreno-remote revoke <appareil> | soreno-remote access | soreno-remote --version";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version") if args.len() == 1 => {
            println!("soreno-remote {}", env!("CARGO_PKG_VERSION"));
        }
        Some(_) => std::process::exit(linux::run(&args)),
        None => {
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use crate::{commands, service, stop::Stop};
    use std::{path::PathBuf, sync::Arc};

    pub fn run(args: &[String]) -> i32 {
        let usage = || {
            eprintln!("{}", crate::USAGE);
            2
        };
        let command = args[0].as_str();
        if !matches!(command, "serve" | "pair" | "revoke" | "access") {
            return usage();
        }
        let Some(home) = std::env::var_os("HOME").filter(|home| !home.is_empty()) else {
            eprintln!("soreno-remote : HOME n’est pas défini.");
            return 1;
        };
        let home = PathBuf::from(home);
        let result = match (command, &args[1..]) {
            ("serve", options) => return serve(home, options),
            ("pair", []) => commands::pair(&home).map(|line| {
                println!("{line}");
                0
            }),
            ("revoke", [id]) => commands::revoke(&home, id),
            ("access", []) => commands::access(&home).map(|line| {
                println!("{line}");
                0
            }),
            _ => return usage(),
        };
        result.unwrap_or_else(|error| {
            eprintln!("soreno-remote : {error}");
            1
        })
    }

    fn serve(home: PathBuf, options: &[String]) -> i32 {
        let relay = match commands::parse_serve(options) {
            Ok(relay) => relay,
            Err(message) => {
                eprintln!("{message}");
                return 2;
            }
        };
        let stop = match Stop::new().and_then(|stop| stop.on_signals().map(|()| stop)) {
            Ok(stop) => Arc::new(stop),
            Err(error) => {
                eprintln!("soreno-remote : signaux : {error}");
                return 1;
            }
        };
        let config = service::Config {
            home,
            host: crate::sessions::host_name(),
            relay,
        };
        if let Err(error) = service::run(config, stop) {
            eprintln!("soreno-remote : {error}");
            return 1;
        }
        eprintln!("soreno-remote : arrêt");
        0
    }
}

#[cfg(not(target_os = "linux"))]
mod linux {
    pub fn run(_args: &[String]) -> i32 {
        eprintln!("soreno-remote : seul Linux est pris en charge.");
        1
    }
}
