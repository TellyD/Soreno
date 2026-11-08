use std::{
    fs,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
};

const ESTABLISHED: u8 = 0x01;
const FIN_WAIT1: u8 = 0x04;
const FIN_WAIT2: u8 = 0x05;

/// Only our own user may talk to the internal server.
pub fn allowed(local: SocketAddr, peer: SocketAddr) -> bool {
    peer_uid(local, peer).is_some_and(|uid| uid == unsafe { libc::geteuid() })
}

fn peer_uid(local: SocketAddr, peer: SocketAddr) -> Option<u32> {
    ["/proc/net/tcp", "/proc/net/tcp6"]
        .into_iter()
        .filter_map(|path| fs::read_to_string(path).ok())
        .find_map(|table| socket_owner(&table, local, peer))
}

/// Owner of the client socket: its local address is our peer and its remote address is us.
pub fn socket_owner(table: &str, local: SocketAddr, peer: SocketAddr) -> Option<u32> {
    let (local, peer) = (canonical(local), canonical(peer));
    table.lines().skip(1).find_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let (source, destination) = (address(fields.get(1)?)?, address(fields.get(2)?)?);
        let state = u8::from_str_radix(fields.get(3)?, 16).ok()?;
        // Time-wait and request sockets are listed with uid 0, and an orphaned FIN_WAIT2
        // socket keeps its state: none of them has an inode.
        let open = matches!(state, ESTABLISHED | FIN_WAIT1 | FIN_WAIT2)
            && fields
                .get(9)
                .is_some_and(|inode| inode.parse::<u64>().is_ok_and(|n| n != 0));
        (open && source == peer && destination == local).then(|| fields.get(7)?.parse().ok())?
    })
}

fn canonical(address: SocketAddr) -> SocketAddr {
    SocketAddr::new(address.ip().to_canonical(), address.port())
}

/// `ADDR:PORT` as the kernel prints it: each 32-bit word of the address in host byte order.
fn address(field: &str) -> Option<SocketAddr> {
    let (address, port) = field.split_once(':')?;
    let port = u16::from_str_radix(port, 16).ok()?;
    let words = address
        .as_bytes()
        .chunks(8)
        .map(|word| {
            let word = std::str::from_utf8(word).ok()?;
            u32::from_str_radix(word, 16).ok().map(u32::to_ne_bytes)
        })
        .collect::<Option<Vec<_>>>()?;
    let ip = match words.as_slice() {
        [word] => IpAddr::V4(Ipv4Addr::from(*word)),
        [a, b, c, d] => {
            let mut bytes = [0u8; 16];
            for (chunk, word) in bytes.chunks_mut(4).zip([a, b, c, d]) {
                chunk.copy_from_slice(word);
            }
            IpAddr::V6(Ipv6Addr::from(bytes))
        }
        _ => return None,
    };
    Some(SocketAddr::new(ip.to_canonical(), port))
}

#[cfg(test)]
#[path = "peer_tests.rs"]
mod tests;
