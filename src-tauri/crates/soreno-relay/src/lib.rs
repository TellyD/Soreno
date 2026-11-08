//! Relays the end-to-end Noise messages of phones to the servers linked to it.
#![cfg(target_os = "linux")]

pub mod http;
pub mod keys;
mod mailbox;
pub mod net;
mod phone;
pub mod relay;
mod server;
pub mod stop;
mod wire;

#[cfg(test)]
#[path = "relay_tests.rs"]
mod relay_tests;
