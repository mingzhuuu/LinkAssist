//! Respect OS/VPN name resolution for relay HTTPS connections. Some local DNS
//! proxies answer the OS resolver but reject iroh's raw DNS packets.
use futures::future::BoxFuture;
use iroh::dns::{BoxIter, DnsError, DnsResolver, Resolver, TxtRecordData};
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    time::Duration,
};

#[derive(Debug, Default)]
struct SystemResolver {
    fallback: DnsResolver,
}

pub fn resolver() -> DnsResolver {
    DnsResolver::custom(SystemResolver::default())
}

async fn system_addresses(host: &str) -> Option<Vec<IpAddr>> {
    let addresses =
        tokio::time::timeout(Duration::from_secs(1), tokio::net::lookup_host((host, 0)))
            .await
            .ok()?
            .ok()?;
    let mut result: Vec<_> = addresses.map(|address| address.ip()).collect();
    result.sort();
    result.dedup();
    Some(result)
}

impl Resolver for SystemResolver {
    fn lookup_ipv4(&self, host: String) -> BoxFuture<'static, Result<BoxIter<Ipv4Addr>, DnsError>> {
        let fallback = self.fallback.clone();
        Box::pin(async move {
            let addresses = match system_addresses(&host).await {
                Some(addresses) => addresses,
                None => fallback
                    .lookup_ipv4(host, Duration::from_secs(2))
                    .await?
                    .collect(),
            };
            Ok(Box::new(addresses.into_iter().filter_map(|ip| match ip {
                IpAddr::V4(ip) => Some(ip),
                _ => None,
            })) as BoxIter<_>)
        })
    }

    fn lookup_ipv6(&self, host: String) -> BoxFuture<'static, Result<BoxIter<Ipv6Addr>, DnsError>> {
        let fallback = self.fallback.clone();
        Box::pin(async move {
            let addresses = match system_addresses(&host).await {
                Some(addresses) => addresses,
                None => fallback
                    .lookup_ipv6(host, Duration::from_secs(2))
                    .await?
                    .collect(),
            };
            Ok(Box::new(addresses.into_iter().filter_map(|ip| match ip {
                IpAddr::V6(ip) => Some(ip),
                _ => None,
            })) as BoxIter<_>)
        })
    }

    fn lookup_txt(
        &self,
        host: String,
    ) -> BoxFuture<'static, Result<BoxIter<TxtRecordData>, DnsError>> {
        let fallback = self.fallback.clone();
        Box::pin(async move {
            let records: Vec<_> = fallback
                .lookup_txt(host, Duration::from_secs(3))
                .await?
                .collect();
            Ok(Box::new(records.into_iter()) as BoxIter<_>)
        })
    }

    fn clear_cache(&self) {
        self.fallback.clear_cache();
    }
    fn reset(&self) -> Box<dyn Resolver> {
        Box::new(Self::default())
    }
}
