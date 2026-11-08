use super::*;

// Captured on x86_64 Linux: addresses are little-endian words.
const TCP: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   3: 0100007F:C207 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 82155098 1 0000000000000000 100 0 0 10 0
  14: 0100007F:C207 0100007F:ECCC 01 00000000:00000000 00:00000000 00000000  1000        0 82155102 1 0000000000000000 22 0 0 10 -1
  15: 0100007F:ECC6 0100007F:C207 01 00000000:00000000 00:00000000 00000000  1001        0 82155099 2 0000000000000000 22 0 0 10 -1
  16: 0100007F:C207 0100007F:ECC6 01 00000000:00000000 00:00000000 00000000  1000        0 82155100 1 0000000000000000 22 0 0 10 -1
  17: 0100007F:C33A 0100007F:C207 06 00000000:00000000 03:00001765 00000000     0        0 0 3 0000000000000000
  18: 0100007F:C33B 0100007F:C207 05 00000000:00000000 03:00001765 00000000     0        0 0 3 0000000000000000
";

const TCP6: &str = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   2: 00000000000000000000000001000000:87C5 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 82155103 1 0000000000000000 100 0 0 10 0
   3: 00000000000000000000000001000000:87C5 00000000000000000000000001000000:B090 01 00000000:00000000 00:00000000 00000000  1000        0 82155105 1 0000000000000000 20 0 0 10 -1
   5: 00000000000000000000000001000000:B090 00000000000000000000000001000000:87C5 01 00000000:00000000 00:00000000 00000000     0        0 82155104 2 0000000000000000 20 0 0 10 -1
  12: 0000000000000000FFFF00000100007F:ECCC 0000000000000000FFFF00000100007F:C207 01 00000000:00000000 00:00000000 00000000  1002        0 82155101 2 0000000000000000 22 0 0 10 -1
";

fn at(address: &str) -> SocketAddr {
    address.parse().unwrap()
}

#[cfg(target_endian = "little")]
#[test]
fn finds_the_client_socket_owner_not_our_accepted_socket() {
    let server = at("127.0.0.1:49671");
    assert_eq!(socket_owner(TCP, server, at("127.0.0.1:60614")), Some(1001));
    assert_eq!(socket_owner(TCP, server, at("127.0.0.1:1")), None);
    assert_eq!(socket_owner(TCP6, server, at("127.0.0.1:60614")), None);
}

#[cfg(target_endian = "little")]
#[test]
fn time_wait_entries_do_not_pass_for_root() {
    assert_eq!(
        socket_owner(TCP, at("127.0.0.1:49671"), at("127.0.0.1:49978")),
        None
    );
}

/// A client that closed right after its request leaves a time-wait socket still shown as FIN_WAIT2.
#[cfg(target_endian = "little")]
#[test]
fn orphaned_fin_wait2_entries_do_not_pass_for_root() {
    assert_eq!(
        socket_owner(TCP, at("127.0.0.1:49671"), at("127.0.0.1:49979")),
        None
    );
}

#[cfg(target_endian = "little")]
#[test]
fn reads_ipv6_and_ipv4_mapped_clients() {
    assert_eq!(
        socket_owner(TCP6, at("[::1]:34757"), at("[::1]:45200")),
        Some(0)
    );
    // An IPv6 socket connected to 127.0.0.1 shows up in tcp6 with a mapped address.
    assert_eq!(
        socket_owner(TCP6, at("127.0.0.1:49671"), at("127.0.0.1:60620")),
        Some(1002)
    );
}

#[test]
fn identifies_a_real_loopback_client_of_this_user() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let _client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (accepted, peer) = listener.accept().unwrap();
    let local = accepted.local_addr().unwrap();
    assert_eq!(peer_uid(local, peer), Some(unsafe { libc::geteuid() }));
    assert!(allowed(local, peer));
}
