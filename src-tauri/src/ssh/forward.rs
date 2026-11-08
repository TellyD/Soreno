use super::{arguments, openssh_unavailable, output, Result, SshConnection};
use crate::process_owner::ProcessOwner;
use serde::Serialize;
use std::{
    collections::HashSet,
    net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant},
};

const PORT_LIMIT: usize = 128;
const START_TIMEOUT: Duration = Duration::from_secs(10);
const STOP_TIMEOUT: Duration = Duration::from_secs(1);
const CONFIG_TIMEOUT: Duration = Duration::from_secs(5);
const CONFIG_LIMIT: usize = 256 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshPortForward {
    pub remote_port: u16,
    pub local_port: u16,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshPortForwardStart {
    pub forwards: Vec<SshPortForward>,
    pub ignored_ports: Vec<String>,
}

struct Tunnel {
    connection: SshConnection,
    forwards: Vec<SshPortForward>,
    child: Child,
    owner: ProcessOwner,
}

static TUNNELS: Mutex<Vec<Tunnel>> = Mutex::new(Vec::new());
static SHUT_DOWN: AtomicBool = AtomicBool::new(false);

fn tunnels() -> MutexGuard<'static, Vec<Tunnel>> {
    TUNNELS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn parse_port(value: &str) -> Option<u16> {
    value.parse().ok().filter(|port| *port > 0)
}

fn parse_ports(value: &str) -> Result<(Vec<u16>, Vec<String>)> {
    let mut ports = Vec::new();
    let mut seen = HashSet::new();
    let mut ignored = Vec::new();
    for token in value.split_whitespace() {
        let parsed = if let Some((start, end)) = token.split_once(':') {
            if end.contains(':') {
                None
            } else {
                parse_port(start).zip(parse_port(end))
            }
        } else {
            parse_port(token).map(|port| (port, port))
        };
        let Some((start, end)) = parsed else {
            ignored.push(token.to_owned());
            continue;
        };
        let ascending = start <= end;
        let mut port = start;
        loop {
            if seen.insert(port) {
                if ports.len() == PORT_LIMIT {
                    return Err(format!(
                        "Un maximum de {PORT_LIMIT} ports peut être transféré."
                    ));
                }
                ports.push(port);
            }
            if port == end {
                break;
            }
            port = if ascending { port + 1 } else { port - 1 };
        }
    }
    if ports.is_empty() {
        return Err("Aucun port valide à transférer.".into());
    }
    Ok((ports, ignored))
}

fn reserve_ports(remote_ports: &[u16]) -> Result<(Vec<TcpListener>, Vec<SshPortForward>)> {
    let mut reservations = Vec::with_capacity(remote_ports.len());
    let mut forwards = Vec::with_capacity(remote_ports.len());
    for &remote_port in remote_ports {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, remote_port))
            .or_else(|_| TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)))
            .map_err(|error| format!("Impossible de réserver un port local : {error}"))?;
        let local_port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        reservations.push(listener);
        forwards.push(SshPortForward {
            remote_port,
            local_port,
        });
    }
    Ok((reservations, forwards))
}

fn arguments_allowing_forwards(connection: &SshConnection) -> Result<Vec<String>> {
    let mut args = arguments(connection)?;
    let clear = args
        .iter_mut()
        .find(|argument| argument.as_str() == "ClearAllForwardings=yes")
        .ok_or("Configuration SSH de transfert incomplète.")?;
    *clear = "ClearAllForwardings=no".into();
    Ok(args)
}

fn configured_forward(config: &str) -> Option<&str> {
    config.lines().find_map(|line| {
        let directive = line.split_ascii_whitespace().next()?;
        ["localforward", "remoteforward", "dynamicforward"]
            .iter()
            .any(|name| directive.eq_ignore_ascii_case(name))
            .then_some(directive)
    })
}

fn reject_configured_forwards(connection: &SshConnection) -> Result<()> {
    let mut command = Command::new("ssh");
    command
        .args(arguments_allowing_forwards(connection)?)
        .args(["-G", "--", &connection.host]);
    let config = String::from_utf8(output(command, None, CONFIG_LIMIT, CONFIG_TIMEOUT)?)
        .map_err(|_| "Configuration OpenSSH non UTF-8.".to_string())?;
    if configured_forward(&config).is_some() {
        return Err("La configuration OpenSSH contient un transfert de port hérité. Supprimez LocalForward, RemoteForward et DynamicForward pour cette connexion.".into());
    }
    Ok(())
}

fn forward_arguments(
    connection: &SshConnection,
    forwards: &[SshPortForward],
) -> Result<Vec<String>> {
    let mut args = arguments_allowing_forwards(connection)?;
    args.extend([
        "-o".into(),
        "ExitOnForwardFailure=yes".into(),
        "-N".into(),
        "-T".into(),
    ]);
    for forward in forwards {
        args.extend([
            "-L".into(),
            format!(
                "127.0.0.1:{}:127.0.0.1:{}",
                forward.local_port, forward.remote_port
            ),
        ]);
    }
    args.extend(["--".into(), connection.host.clone()]);
    Ok(args)
}

fn terminate(tunnel: &mut Tunnel) {
    tunnel.owner.terminate(&mut tunnel.child, STOP_TIMEOUT);
}

fn remove(connection: &SshConnection, tunnels: &mut Vec<Tunnel>) {
    let mut index = 0;
    while index < tunnels.len() {
        if tunnels[index].connection == *connection {
            let mut tunnel = tunnels.remove(index);
            terminate(&mut tunnel);
        } else {
            index += 1;
        }
    }
}

fn wait_started(tunnel: &mut Tunnel) -> Result<()> {
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        if let Some(status) = tunnel.child.try_wait().map_err(|error| error.to_string())? {
            return Err(format!(
                "Le tunnel SSH s’est arrêté au démarrage ({status})."
            ));
        }
        let ready = tunnel.forwards.iter().all(|forward| {
            TcpStream::connect_timeout(
                &SocketAddrV4::new(Ipv4Addr::LOCALHOST, forward.local_port).into(),
                Duration::from_millis(50),
            )
            .is_ok()
        });
        if ready {
            thread::sleep(Duration::from_millis(100));
            return match tunnel.child.try_wait().map_err(|error| error.to_string())? {
                Some(status) => Err(format!(
                    "Le tunnel SSH s’est arrêté au démarrage ({status})."
                )),
                None => Ok(()),
            };
        }
        if Instant::now() >= deadline {
            return Err("Délai dépassé pendant le démarrage du tunnel SSH.".into());
        }
        thread::sleep(Duration::from_millis(25));
    }
}

pub(super) fn list(connection: &SshConnection) -> Result<Vec<SshPortForward>> {
    let mut tunnels = tunnels();
    if let Some(index) = tunnels
        .iter_mut()
        .position(|tunnel| tunnel.connection == *connection)
    {
        if tunnels[index]
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            let mut tunnel = tunnels.remove(index);
            terminate(&mut tunnel);
            return Ok(Vec::new());
        }
        return Ok(tunnels[index].forwards.clone());
    }
    Ok(Vec::new())
}

pub(super) fn start(connection: &SshConnection, ports: &str) -> Result<SshPortForwardStart> {
    let (remote_ports, ignored_ports) = parse_ports(ports)?;
    let mut tunnels = tunnels();
    if SHUT_DOWN.load(Ordering::Acquire) {
        return Err("Transport SSH arrêté.".into());
    }
    if super::is_blocked(connection) {
        return Err("Connexion SSH bloquée : reconnectez explicitement le projet.".into());
    }
    reject_configured_forwards(connection)?;
    remove(connection, &mut tunnels);
    let (reservations, forwards) = reserve_ports(&remote_ports)?;
    let mut command = Command::new("ssh");
    command
        .args(forward_arguments(connection, &forwards)?)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    ProcessOwner::configure(&mut command);
    drop(reservations);
    let mut child = command.spawn().map_err(openssh_unavailable)?;
    let owner = ProcessOwner::new(&child).map_err(|error| {
        let _ = child.kill();
        let _ = child.wait();
        error.to_string()
    })?;
    let mut tunnel = Tunnel {
        connection: connection.clone(),
        forwards: forwards.clone(),
        child,
        owner,
    };
    if let Err(error) = wait_started(&mut tunnel) {
        terminate(&mut tunnel);
        return Err(error);
    }
    tunnels.push(tunnel);
    Ok(SshPortForwardStart {
        forwards,
        ignored_ports,
    })
}

pub(super) fn stop(connection: &SshConnection) {
    remove(connection, &mut tunnels());
}

pub(super) fn shutdown() {
    let mut tunnels = tunnels();
    SHUT_DOWN.store(true, Ordering::Release);
    for mut tunnel in tunnels.drain(..) {
        terminate(&mut tunnel);
    }
}

#[cfg(test)]
fn reset_test_forwards() {
    let mut tunnels = tunnels();
    for mut tunnel in tunnels.drain(..) {
        terminate(&mut tunnel);
    }
    SHUT_DOWN.store(false, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection(host: &str) -> SshConnection {
        SshConnection {
            host: host.into(),
            user: None,
            port: None,
            identity_file: None,
            host_key: None,
        }
    }

    #[test]
    fn parses_ranges_invalid_values_duplicates_and_reverse_order() {
        let (ports, ignored) = parse_ports("3000 3002:3000 nope 0 65536 3001 12:13:14").unwrap();
        assert_eq!(ports, [3000, 3002, 3001]);
        assert_eq!(ignored, ["nope", "0", "65536", "12:13:14"]);
        assert!(parse_ports("nope 0 65536 1:bad").is_err());
    }

    #[test]
    fn rejects_more_than_the_port_limit() {
        assert!(parse_ports("1:128").is_ok());
        assert!(parse_ports("1:129").unwrap_err().contains("128"));
    }

    #[test]
    fn builds_safe_openssh_forward_arguments() {
        let forwards = [
            SshPortForward {
                remote_port: 3000,
                local_port: 3000,
            },
            SshPortForward {
                remote_port: 8080,
                local_port: 49152,
            },
        ];
        let args = forward_arguments(&connection("example.com"), &forwards).unwrap();
        assert!(args.contains(&"ClearAllForwardings=no".into()));
        assert!(!args.contains(&"ClearAllForwardings=yes".into()));
        assert!(args.contains(&"ExitOnForwardFailure=yes".into()));
        assert_eq!(args.iter().filter(|argument| *argument == "-L").count(), 2);
        assert!(args.contains(&"127.0.0.1:3000:127.0.0.1:3000".into()));
        assert!(args.contains(&"127.0.0.1:49152:127.0.0.1:8080".into()));
        assert_eq!(&args[args.len() - 2..], ["--", "example.com"]);
        assert!(forward_arguments(&connection("-oProxyCommand=evil"), &forwards).is_err());
    }

    #[test]
    fn detects_only_forward_directives_in_effective_config() {
        assert_eq!(
            configured_forward("hostname example.com\nlocalforward 3000 127.0.0.1:3000\n"),
            Some("localforward")
        );
        assert_eq!(
            configured_forward("  RemoteForward 8080 127.0.0.1:8080\n"),
            Some("RemoteForward")
        );
        assert_eq!(
            configured_forward("dynamicforward 1080\n"),
            Some("dynamicforward")
        );
        assert_eq!(
            configured_forward("hostname localforward.example\nforwardagent no\n"),
            None
        );
    }

    #[test]
    fn blocked_and_shutdown_connections_cannot_start_forwards() {
        let connection = connection("blocked-forward.test");
        reset_test_forwards();
        crate::ssh::block(&connection);
        assert!(start(&connection, "3000").unwrap_err().contains("bloquée"));
        crate::ssh::unblock(&connection);
        shutdown();
        assert!(start(&connection, "3000").unwrap_err().contains("arrêté"));
        reset_test_forwards();
    }

    #[test]
    fn serialized_types_use_camel_case() {
        let value = serde_json::to_value(SshPortForwardStart {
            forwards: vec![SshPortForward {
                remote_port: 80,
                local_port: 8080,
            }],
            ignored_ports: vec!["22".into()],
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "forwards": [{ "remotePort": 80, "localPort": 8080 }],
                "ignoredPorts": ["22"],
            })
        );
    }
}
