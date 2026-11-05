# TCP/IP OS fingerprinting research (measured, 2026-11-04)

Answer: a Linux host can match Windows on TTL, window size, window scale, DF
and ECN with sysctls, but NOT on TCP option order — which p0f and JA4T both
read. In the test, changing ONLY the option order flipped p0f from "Linux
2.2.x-3.x (no timestamps)" to "Windows NT kernel". And through SOCKS5 or HTTP
CONNECT proxies, the target sees the PROXY's TCP stack, not the scraper's.

## Reference signatures

| OS | JA4T | Options (wire order) | Notes |
|---|---|---|---|
| Windows 10/11 | `64240_2-1-3-1-1-4_1460_8` | mss,nop,ws,nop,nop,sok — NO timestamp option | init TTL 128 |
| Linux (this kernel) | `64240_2-4-8-1-3_1460_10` | mss,sok,ts,nop,ws | init TTL 64 |
| macOS | `65535_2-1-3-1-1-8-4-0_1460_6` | mss,nop,ws,nop,nop,ts,sok,eol | ends with EOL |

## What sysctls CAN fix (measured on kernel 7.0.14-linuxkit)

| Field | Knob | Effect |
|---|---|---|
| TTL | `net.ipv4.ip_default_ttl` | 64 → 128 ✓ |
| Window/WS | `net.ipv4.tcp_rmem` (default max) | 64240 / WS 10 → WS 8 at 8 MiB max ✓ |
| DF | `net.ipv4.ip_no_pmtu_disc` (keep 0) | Windows sets DF ✓ |
| ECN | `net.ipv4.tcp_ecn` (default 2) | 1% of Windows SYNs carry ECN ✓ |

## What sysctls CANNOT fix

- **TCP option order** — hard-coded in `tcp_options_write`; no sysctl changes
  it. Crafted SYN with Windows fields in Windows ORDER → p0f says "Windows NT
  kernel". The fields that differ from Windows are only the positions of kinds
  3 (WS) and 4 (SACK-permitted).
- nftables can MATCH and REMOVE options but cannot INSERT or REORDER them.
  NFQUEUE rewriters exist (OSfooler-ng, last push 2023, p0f v2 format) but are
  unmaintained.

## The proxy layer (decisive for mass scraping)

- **SOCKS5 / HTTP CONNECT**: the proxy host opens the TCP connection to the
  origin — the target sees the PROXY's stack (its TTL, options, window, MSS).
  The scraper's TCP fingerprint never reaches the target.
- **TCP-intercepting VPN exits** (Nord/Surfshark): exit's stack
  (`65535_2-4-8-1-3_1460_9` measured by FoxIO).
- **L3 tunnels with no TCP termination**: scraper's own options reach the
  target (MSS reduced by tunnel overhead — 1380 is itself a tunnel tell).
- **Implication**: with proxied traffic, the TCP layer is NOT a persona-mismatch
  surface for us (the proxy's stack replaces it); the browser's TLS/HTTP layers
  are what must match the persona. For direct (non-proxied) connections, the
  TCP layer matters and OS==persona-OS is the cheap mitigation.

## Cross-layer checks

- p0f flags `us_vs_os` (OS fingerprint vs User-Agent mismatch);
  zardaxt compares TCP OS vs UA OS — measured: Windows UA on a Mac SYN
  returned `os_mismatch: false` (probability 0.7524 vs threshold 0.8) on one
  call from one IP.
- Cloudflare's docs have NO TCP-layer signal (grepped all 80 bots pages) —
  JA4 signals are HTTP-level.

## Test commands

- `tcpdump -nn -vv -s 0 -c 1 -i any 'tcp[tcpflags] & tcp-syn != 0 and tcp[tcpflags] & tcp-ack == 0'`
- `p0f -r file.pcap -f /path/to/p0f.fp` (v3.09b; DB is 2012-stale — know its limits)
- Endpoints: `tls.peet.ws/api/all` (tcp_syn block + p0f string), `tcpip.incolumitas.com/classify?by_ip=1&ua=`, `browserleaks.com/tcp`

Sources: p0f README + p0f.fp (2012) · zardaxt (NikolaiT/zardaxt) · JA4/JA4T
(FoxIO-LLC/ja4, ja4tscan, JA4T.png spec) · FoxIO VPN posts · kernel
ip-sysctl.rst + tcp_options_write source · nftables manpage · RFC 791/1928/9110.
Measured on Docker Desktop linuxkit with `--sysctl` + tcpdump + p0f 3.09b;
Windows/iOS/Android not measured on real hosts (JA4T values from FoxIO's
published tables).
