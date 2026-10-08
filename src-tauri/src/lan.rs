//! Addresses other devices on the network can reach this computer at, best
//! first. Virtual adapters (Hyper-V, WSL, VirtualBox, VPNs) come last: no
//! phone can reach those. Self-assigned 169.254.x addresses are dropped.

use std::net::IpAddr;

pub fn lan_addresses() -> Vec<String> {
    let virt = regex::RegexBuilder::new(
        r"virtual|vmware|vbox|hyper-v|vethernet|docker|wsl|loopback|tailscale|zerotier|hamachi|radmin|openvpn|wireguard|utun|awdl|llw|bridge|\btun|\btap|^veth|^br-|^virbr",
    )
    .case_insensitive(true)
    .build()
    .unwrap();
    let mut found: Vec<(u8, usize, String)> = Vec::new();
    if let Ok(ifs) = if_addrs::get_if_addrs() {
        for (order, i) in ifs.into_iter().enumerate() {
            if i.is_loopback() {
                continue;
            }
            let IpAddr::V4(v4) = i.ip() else { continue };
            if v4.is_link_local() {
                continue;
            }
            let private = v4.is_private();
            let score = if virt.is_match(&i.name) { 2 } else { 0 } + if private { 0 } else { 1 };
            found.push((score, order, v4.to_string()));
        }
    }
    found.sort();
    let mut out: Vec<String> = Vec::new();
    for (_, _, a) in found {
        if !out.contains(&a) {
            out.push(a);
        }
    }
    out
}
