"""Local authenticating proxy forwarder.

Chrome's `--proxy-server` flag cannot carry credentials. The obvious CDP path
(`Fetch.enable` + answer `Fetch.authRequired`) proved unreliable: with auth
interception active, requests stalled at the Fetch layer and never reached the
upstream at all (zero connections to the proxy, every navigation hung). It is
also a stealth liability -- intercepting every request adds observable timing.

The robust, industry-standard fix is a tiny local forwarder. Chrome connects to
`127.0.0.1:<port>` with NO auth; for every `CONNECT` this forwarder opens a
tunnel to the authenticated upstream proxy, injects the `Proxy-Authorization`
header, and then pipes bytes verbatim. Chrome's own TLS handshake travels
end-to-end to the target, so the authentic JA3/TLS fingerprint is preserved -- a
TLS-terminating MITM would replace it, which is exactly what we must avoid.

One upstream host + one sticky-session username are fixed for the forwarder's
lifetime, so the whole browser session exits via a single residential IP (a
coherent identity, not a new IP per request).
"""

from __future__ import annotations

import asyncio
import base64


class ProxyForwarder:
    """An asyncio localhost proxy that authenticates to one upstream proxy.

    Usage:
        fwd = ProxyForwarder("gate.example.net", 60000, "user-session-x", "pw")
        port = await fwd.start()           # bound on 127.0.0.1:<port>
        # ... point Chrome at http://127.0.0.1:<port> (no auth) ...
        await fwd.stop()
    """

    def __init__(self, upstream_host: str, upstream_port: int,
                 username: str, password: str):
        self._uh = upstream_host
        self._up = upstream_port
        self._auth = base64.b64encode(
            f"{username}:{password}".encode()).decode().encode()
        self._server: asyncio.AbstractServer | None = None
        self.port: int | None = None

    async def start(self) -> int:
        self._server = await asyncio.start_server(
            self._on_client, "127.0.0.1", 0)
        port = self._server.sockets[0].getsockname()[1]
        self.port = port
        return port

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            try:
                await self._server.wait_closed()
            except Exception:  # noqa: BLE001 - shutdown best-effort
                pass
            self._server = None

    async def _on_client(self, creader: asyncio.StreamReader,
                         cwriter: asyncio.StreamWriter) -> None:
        try:
            request_line = await creader.readline()
            if not request_line:
                return
            parts = request_line.split()
            if len(parts) < 2:
                return
            method, target = parts[0].upper(), parts[1]
            # capture (and drop) the client->proxy header block; we re-issue our
            # own headers upstream. A CONNECT has no body; plain HTTP may, which
            # we stream through after the headers.
            header_block = b""
            while True:
                h = await creader.readline()
                header_block += h
                if h in (b"\r\n", b"\n", b""):
                    break
            if method == b"CONNECT":
                await self._tunnel(target, creader, cwriter)
            else:
                await self._plain_http(request_line, header_block,
                                       creader, cwriter)
        except Exception:  # noqa: BLE001 - one client failure is not fatal
            pass
        finally:
            try:
                cwriter.close()
            except Exception:  # noqa: BLE001
                pass

    async def _tunnel(self, target: bytes, creader: asyncio.StreamReader,
                     cwriter: asyncio.StreamWriter) -> None:
        ureader, uwriter = await asyncio.open_connection(self._uh, self._up)
        uwriter.write(
            b"CONNECT " + target + b" HTTP/1.1\r\n"
            b"Host: " + target + b"\r\n"
            b"Proxy-Authorization: Basic " + self._auth + b"\r\n"
            b"Proxy-Connection: Keep-Alive\r\n\r\n")
        await uwriter.drain()
        status = await ureader.readline()
        while True:  # drain upstream response headers
            h = await ureader.readline()
            if h in (b"\r\n", b"\n", b""):
                break
        if b" 200" not in status:
            cwriter.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            await cwriter.drain()
            uwriter.close()
            return
        cwriter.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        await cwriter.drain()
        await self._pipe(creader, cwriter, ureader, uwriter)

    async def _plain_http(self, request_line: bytes, header_block: bytes,
                         creader: asyncio.StreamReader,
                         cwriter: asyncio.StreamWriter) -> None:
        # Chrome sends an absolute-form request line to a proxy
        # ("GET http://host/path HTTP/1.1"); forward it with our auth header.
        # Detectors are all HTTPS (CONNECT) -- this is a robustness fallback.
        ureader, uwriter = await asyncio.open_connection(self._uh, self._up)
        scrubbed = b"".join(
            line for line in header_block.splitlines(keepends=True)
            if not line.lower().startswith(b"proxy-authorization:"))
        uwriter.write(request_line)
        uwriter.write(b"Proxy-Authorization: Basic " + self._auth + b"\r\n")
        uwriter.write(scrubbed)
        await uwriter.drain()
        await self._pipe(creader, cwriter, ureader, uwriter)

    @staticmethod
    async def _pipe(cr: asyncio.StreamReader, cw: asyncio.StreamWriter,
                   ur: asyncio.StreamReader, uw: asyncio.StreamWriter) -> None:
        async def copy(r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
            try:
                while True:
                    data = await r.read(65536)
                    if not data:
                        break
                    w.write(data)
                    await w.drain()
            except Exception:  # noqa: BLE001 - peer closed / reset
                pass
            finally:
                try:
                    w.close()
                except Exception:  # noqa: BLE001
                    pass
        await asyncio.gather(copy(cr, uw), copy(ur, cw))
