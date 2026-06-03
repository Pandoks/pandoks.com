# pandoks_browser — project context

Monorepo for **`pandoks.com`** (personal site, infra, k8s cluster) **plus the
in-progress stealth-browser product**: a Browserbase-class stealth Chrome
service (`packages/stealth-browser/`, Python) backed by a custom-patched
Chromium recipe (`packages/stealth-chromium/`, C++ overlays + anchor edits).
The Chromium binary is built ephemerally on EC2 via an SFN-orchestrated AMI
builder (`infra/builder/`). Two stages: `production` and per-user dev
(default `pandoks`). The "personal site" half is mature and documented in
`.claude/rules/`; the "browser" half is recent (since branch
`browser-iterations`) and is the active work.

## Table of contents

| File                                 | What's in it                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)   | Monorepo layout, SST topology, the new builder + stealth-browser/chromium subsystems     |
| [conventions.md](conventions.md)     | Code style per language — TS rules already cited; **Python is new and unwritten**        |
| [gotchas.md](gotchas.md)             | Stealth-browser pitfalls, builder SFN footguns, Chromium-build sharp edges, `APEX_*` legacy |
| [workflows.md](workflows.md)         | Commands: install, dev, lint, deploy, **launching SFN builds, fetching artifacts**       |
| [entry-points.md](entry-points.md)   | Where execution starts — Python HTTP service, Lambda handlers, SFN, build scripts        |

## How this relates to `.claude/rules/`

`.claude/rules/*` covers the original `pandoks.com` site, SST infra, k8s
cluster, Notion/SMS/web flows in deep detail — keep reading those for any
work touching `apps/web/`, `apps/functions/`, `k3s/`, or `infra/api,dns,
github,kubernetes,secrets,tailscale,vps,storage,cloudflare,website,dev`.
**This `.claude/context/` directory is the dive for the browser side**:
`infra/builder/`, `packages/stealth-browser/`, `packages/stealth-chromium/`.
Don't duplicate — when both cover the same surface, rules wins.

Last generated: 2026-05-26
