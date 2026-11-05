# Network-layer fingerprinting checklist (measured, 2026-11-04)

Key result: route every browser context through a plain CONNECT/SOCKS5 tunnel
(per-context `proxyServer`) so Chrome's own TLS/h2/header prints reach the
target untouched; treat any TLS-terminating hop as fatal. Measured: direct vs
passthrough CONNECT → identical JA4 + Akamai h2 print; through mitmproxy →
everything except the header list becomes the proxy's. A TLS-terminating proxy
replaces the browser's TLS/h2 fingerprint with its own (measured live).

## TLS (JA4)

- Chrome randomizes ClientHello extension order since ~Chrome 110
  (`SSL_set_permute_extensions` + GREASE), so JA3 is unstable and JA4 (sorted)
  is the stable identifier. Chrome 157 canonical JA4:
  `t13d1516h2_8daaf6152771_806a8c22fdea` (measured). JA4_c changes with the
  extension SET (ALPS codepoint, ECH GREASE, PSK on resumption) and the
  sigalgs (Chrome 157 starts with ML-DSA).
- Cloudflare scores JA4 against hourly global ratios (15M+ unique JA4s/day) —
  a JA4 only we emit (patched TLS, MITM proxy, stale build) has a population
  of one: `heuristic_ratio`, `uas_rank`, `ips_quantile`, `paths_rank` are all
  ours. **Never touch BoringSSL ClientHello construction, cipher/group/sigalg
  prefs, ALPS, ECH or GREASE in the C++ patches; keep the build on current
  stable BoringSSL.** (Partially satisfied: our patches are JS-surface only;
  verify the build's BoringSSL isn't pinned stale.)
- Residential proxy vendors can terminate TLS opt-in (Bright Data "SSL
  Analyzing") — test every pool: diff `tls.ja4` + `http2.akamai_fingerprint` +
  header order direct vs via proxy; they must be byte-identical.

## HTTP/2

Chrome 157 print (measured): `1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p`.
Chrome sends NO SETTINGS 9 and NO PRIORITY frames (correction to earlier
assumptions). Knobs that would alter the print (`enable_http2_settings_grease`,
`greased_http2_frame`, `enable_priority_update`) must stay default. Behind any
proxy Chrome won't use QUIC (SOCKS5 is TCP-only, HTTPS proxy no QUIC) — every
proxied request is h2.

## Headers

Chrome 157 navigation header order (measured, matches Chromium source):
`:method, :authority, :scheme, :path, sec-ch-ua, sec-ch-ua-mobile,
sec-ch-ua-platform, upgrade-insecure-requests, user-agent, accept,
sec-fetch-site, sec-fetch-mode, sec-fetch-user, sec-fetch-dest,
accept-encoding, accept-language, priority: u=0, i`.
`sec-ch-ua` is a pure function of the major version (GREASE brand +
`chars[seed%11]` + permutations) — a spoofed major with the wrong GREASE brand
is a direct tell. A Windows persona on Linux must also fix `platformVersion`
(≥13.0.0 = Win11; empty on Linux) + `architecture`/`bitness`/`wow64`.
Accept-Language: first tag bare then `;q=0.9` format. Headless-shell sends no
`accept-language` — run headed.

## Proxy architecture (for mass scraping)

- One browser context per persona; `proxyServer` = blind HTTP CONNECT or
  SOCKS5 (no CA, no header injection, no "SSL analyzing"). Verify blindness
  per pool with the direct-vs-proxy diff.
- Record each exit's `tcpip.tcp_syn`/JA4T from tls.peet.ws; match persona OS
  to the exit's stack (or pick Linux/Android personas for Linux exits).
- WebRTC: use `--force-webrtc-ip-handling-policy` (the actual Chromium switch
  name; patchright's README spells it wrong).
- Rotate across ASNs (Cloudflare detection ID 50331648 is per-ASN;
  residential pools score 29 regardless — detection ID 50331651).
- Do not use `--headless`, UA overrides without matching UA-CH metadata, or
  TLS-terminating "stealth" proxies.

Sources: measured Chrome for Testing 157 vs mitmproxy (passthrough vs MITM) ·
JA4 spec + Rust reference (FoxIO) · BoringSSL extensions.cc · Chromium
ssl_client_socket_impl.cc, proxy.md, user_agent_utils.cc (GREASE algorithm
reproduced and verified for majors 116-157) · Cloudflare JA4 Signals + bot
variables + detection IDs · mitmproxy _http2.py · TrackMe fingerprint_h2.go.
Probe scratch cleaned; repo working tree untouched.
