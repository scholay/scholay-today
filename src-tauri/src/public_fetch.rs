//! Bounded public fetches for untrusted MCP URLs and exported image URLs.
//! Re-resolve and pin each redirect hop; never follow into private networks.
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(i) => {
            let a = i.octets();
            !i.is_private()
                && !i.is_loopback()
                && !i.is_link_local()
                && !i.is_unspecified()
                && !i.is_broadcast()
                && !i.is_multicast()
                && a[0] != 0
                && a[0] < 224
                && !(a[0] == 100 && (64..=127).contains(&a[1]))
        }
        IpAddr::V6(i) => {
            !i.is_loopback()
                && !i.is_unspecified()
                && !i.is_unique_local()
                && !i.is_unicast_link_local()
                && !i.is_multicast()
                && i.to_ipv4_mapped().is_none()
        }
    }
}
pub async fn resolve(raw: &str) -> Result<(url::Url, Vec<SocketAddr>), String> {
    let u = url::Url::parse(raw).map_err(|_| "Invalid URL")?;
    if !matches!(u.scheme(), "http" | "https") || !u.username().is_empty() || u.password().is_some()
    {
        return Err("Use public HTTP(S) URLs without credentials".into());
    }
    let host = u.host_str().ok_or("Missing host")?.trim_matches(['[', ']']);
    let addresses: Vec<_> = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::lookup_host((host, u.port_or_known_default().unwrap_or(443))),
    )
    .await
    .map_err(|_| "DNS timeout")?
    .map_err(|_| "Could not resolve source")?
    .collect();
    if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
        return Err("Private/local addresses are not permitted for this operation".into());
    }
    Ok((u, addresses))
}
pub async fn fetch(
    raw: &str,
    referer: Option<&str>,
    max: usize,
) -> Result<(Vec<u8>, String, String), String> {
    let mut next = raw.to_owned();
    for _ in 0..6 {
        let (u, addresses) = resolve(&next).await?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(18))
            .resolve_to_addrs(u.host_str().unwrap(), &addresses)
            .build()
            .map_err(|_| "Could not create fetch client")?;
        let mut request=client.get(u.clone()).header("User-Agent","Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15");
        if let Some(r) = referer {
            request = request.header("Referer", r);
        }
        let mut response = request.send().await.map_err(|_| "Network request failed")?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get("location")
                .and_then(|h| h.to_str().ok())
                .ok_or("Redirect has no location")?;
            next = u
                .join(location)
                .map_err(|_| "Invalid redirect")?
                .to_string();
            continue;
        }
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status().as_u16()));
        }
        if response.content_length().is_some_and(|n| n > max as u64) {
            return Err("Resource exceeds size limit".into());
        }
        let mime = response
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .to_string();
        let mut bytes = vec![];
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Resource transfer failed")?
        {
            if bytes.len() + chunk.len() > max {
                return Err("Resource exceeds size limit".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok((bytes, mime, u.to_string()));
    }
    Err("Too many redirects".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_internal_destinations() {
        for s in [
            "127.0.0.1",
            "10.0.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
        ] {
            assert!(!public_ip(s.parse().unwrap()), "{s}");
        }
        assert!(public_ip("8.8.8.8".parse().unwrap()));
    }
}
