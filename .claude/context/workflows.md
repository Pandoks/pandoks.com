# Workflows (browser-side)

For pandoks.com workflows (install/dev/build/lint/deploy + CI matrix),
read `.claude/rules/workflows.md` first. This file covers the
browser-side commands only.

## Install (Python)

Python is a separate toolchain from pnpm — `pnpm install` does NOT
install Python deps. Set up uv once, then sync the workspace:

```sh
brew install uv                          # macOS; Python package manager
cd packages/stealth-browser
uv sync                                  # creates .venv, installs deps from pyproject.toml
```

`uv` reads the root `pyproject.toml` (workspace declaration at
`pyproject.toml:10-13`) and the package-local
`packages/stealth-browser/pyproject.toml`. The `stealth-chromium`
package is **NOT** a uv member (`pyproject.toml:14-16` comment) — it
has no `pyproject.toml`.

## Run the stealth-browser service locally

```sh
cd packages/stealth-browser
APEX_CORE=patchright PORT=8089 uv run stealth-browser

# smoke-test in a second terminal:
curl -s localhost:8089/health
SID=$(curl -s -XPOST localhost:8089/sessions \
      -H 'content-type: application/json' -d '{}' | jq -r .id)
curl -s -XPOST localhost:8089/sessions/$SID/navigate \
      -H 'content-type: application/json' \
      -d '{"url":"https://example.com"}'
curl -s -XDELETE localhost:8089/sessions/$SID
```

Required environment / dependencies (`HANDOFF.md:230-243`):

- **System Google Chrome** installed (real Chrome, not bundled). macOS:
  Chrome.app the normal way. Linux: `apt-get install
  google-chrome-stable` (or `APEX_CHROME_PATH=/path/to/patched/chrome`).
- **Xvfb** on Linux only — service is headful by design.
- **`jq`** for the smoke-test curl commands.

Environment-variable surface (`HANDOFF.md:246-254`):

| Var | Values | Purpose |
| --- | --- | --- |
| `APEX_CORE` | `nodriver` \| `patchright` | Transport choice. `nodriver` = CDP-direct (stealthier). `patchright` = patched Playwright (better ergonomics). |
| `PORT` | int, default `8089` | HTTP service port (note `server.py:45` defaults to 8089, the README sometimes says 8088 — code wins). |
| `APEX_CHROME_PATH` | abs path | Override Chrome binary. Point at the patched stealth-chromium output once built. |
| `APEX_FP_*` | various | Per-session fingerprint overrides — only active when running the patched binary. The service sets these from `fp_profiles.py` automatically. |
| `OXYLABS_USERNAME` / `OXYLABS_PASSWORD` / `OXYLABS_PROXIES` | strings | Optional residential proxy credentials. |
| `PROXY_HOST` (+ related) | strings | Generic proxy via `proxy.from_env()` (see `core_nodriver.py:23`). |
| `APEX_PROFILE` | label substring | Device profile selector ("m1 pro", "rtx 3060", ...). Per-request takes precedence. |

## Build patched Chromium — local (multi-hour, operator machine)

```sh
cd packages/stealth-chromium

# one-time: fetch ~100GB Chromium source
APEX_CHROMIUM_WORK=/Volumes/X9Pro/apex-chromium-build scripts/setup.sh

# fast, idempotent: apply overlays + anchor edits to the checkout
APEX_CHROMIUM_WORK=/Volumes/X9Pro/apex-chromium-build scripts/apply.sh

# multi-hour first build; subsequent ones are incremental
APEX_CHROMIUM_WORK=/Volumes/X9Pro/apex-chromium-build scripts/build.sh
```

Output binary at
`$APEX_CHROMIUM_WORK/chromium/src/out/apex/Chromium.app/Contents/MacOS/Chromium`
(macOS) or `$APEX_CHROMIUM_WORK/chromium/src/out/apex/chrome` (Linux).
Set `APEX_CHROME_PATH=/path/to/Chromium` and the stealth-browser
service switches to the patched binary automatically.

Verify a single anchor without rebuilding:

```sh
APEX_CHROMIUM_WORK=$WORK python3 scripts/apply_edits.py --check
```

After a successful build:

```sh
scripts/test_patched_binary.sh   # loads verify_patches.html, asserts PASS on all probes
```

For raw-CDP probing of a single patch (no Python service):

```sh
uv run --project ../stealth-browser python scripts/cdp_probe.py
```

## Build patched Chromium — via the SFN builder (recommended)

The ephemeral EC2 builder in `infra/builder/` runs the build on a
freshly-launched instance, uploads the binary to S3, terminates the
instance. Cold build ~7h on `c7i.4xlarge`; warm cache ~45 min.

### Prereqs (one-time)

- AWS SSO via `pnpm run sso` (account `Personal`, 12h validity).
- `dev-builder` (or `prod-builder`) state machine deployed: `pnpm sst
  deploy --stage dev` (or `--stage production`). Both already exist as
  of 2026-05-26.
- Branch **pushed to GitHub** — SFN does `git clone --branch <ref>`,
  local-only branches are invisible.

### Start a build

```sh
export AWS_PROFILE=Personal AWS_REGION=us-west-1
BUILD_ID="stealth-chromium-$(date +%Y%m%d-%H%M%S)"

aws stepfunctions start-execution \
  --state-machine-arn arn:aws:states:us-west-1:343487555569:stateMachine:dev-builder \
  --name "$BUILD_ID" \
  --input "$(jq -nc \
    --arg id "$BUILD_ID" \
    --arg ref "$(git rev-parse --abbrev-ref HEAD)" \
    '{id:$id, ref:$ref,
      instanceType:"c7i.4xlarge",
      marketType:"on-demand",
      rootVolumeSizeGb:200,
      command:"bash packages/stealth-chromium/scripts/sfn-build.sh"}')"
```

**Sizing notes** (`stealth-chromium/README.md:208-222`):

- `instanceType` must be in `ARM_INSTANCE_TYPES ∪ X86_INSTANCE_TYPES`
  (`infra/builder/types.ts`). Arch is auto-routed.
- `marketType: 'spot'` is ~4× cheaper but interruption mid-build loses
  the work. Use `'on-demand'` for cold builds.
- `rootVolumeSizeGb` **must be at least 200** for Chromium. Default is
  30 GB if omitted — fine for hello-world only.

### Monitor

```sh
# top-line status
aws stepfunctions describe-execution \
  --execution-arn "arn:aws:states:us-west-1:343487555569:execution:dev-builder:$BUILD_ID" \
  --query '{status:status,started:startDate,stopped:stopDate,error:error}' \
  --output table

# step history (newest first)
aws stepfunctions get-execution-history \
  --execution-arn "arn:aws:states:us-west-1:343487555569:execution:dev-builder:$BUILD_ID" \
  --max-results 20 --reverse-order \
  --query 'events[].{ts:timestamp,type:type,name:stateEnteredEventDetails.name}' \
  --output table

# live build log (CloudWatch — SSM RunShellScript streams here)
aws logs tail "/aws/ssm/AWS-RunShellScript" --follow \
  --filter-pattern "$BUILD_ID"
```

### Fetch the artifact

```sh
ARTIFACTS_BUCKET=personal-pandoks-builderartifactsbucketbucket-oawuxubt
aws s3 cp "s3://${ARTIFACTS_BUCKET}/${BUILD_ID}/manifest.json" - | jq .
aws s3 cp "s3://${ARTIFACTS_BUCKET}/${BUILD_ID}/chromium-148.0.7778.179.tar.zst" .
tar --use-compress-program 'zstd -d --long=27' -xf chromium-148.0.7778.179.tar.zst -C /opt/stealth-chromium/
export APEX_CHROME_PATH=/opt/stealth-chromium/chrome
```

### Diagnose a failure

`sfn-build.sh` traps `ERR` and uploads the last 1MB of the build log
**before** the SFN terminates the instance. Pull it:

```sh
aws s3 cp "s3://${ARTIFACTS_BUCKET}/${BUILD_ID}/build-failure.log" -
```

Common failure patterns to grep:

- `ANCHOR NOT FOUND` → an `apply_edits.py` anchor drifted after a
  Chromium version bump. Fix the anchor string.
- `ld64.lld` / `dyld: unknown imports format` → stale toolchain cache.
  Recovery: delete `out/apex/obj/v8/v8_context_snapshot_generator/` +
  `.ninja_deps`, re-link.
- `no space left on device` → root volume too small. Pass
  `rootVolumeSizeGb: 200`+ next time.

### Cost ballpark

| Build | Duration | Cost (us-west-1) |
| --- | --- | --- |
| cold c7i.4xlarge on-demand, no cache | ~7h | ~$5 |
| warm incremental (cache HIT) | ~45 min | ~$0.55 |
| spot variant (interruption risk) | ~7h | ~$1.40 |

S3 storage: ~$0.40/mo for Chromium src + ccache tarballs combined.

## Lint / format / typecheck

- **TypeScript / infra** — covered by `pnpm check`, `pnpm lint js`,
  `pnpm format js`, `pnpm fix js`. See `.claude/rules/workflows.md`.
- **Python** — **no repo-wide dispatcher yet**
  (`HANDOFF.md:78-80, 211-213`). Run manually:

  ```sh
  cd packages/stealth-browser
  uv run ruff check .
  uv run ruff format .
  ```

  Future work: add `py` subcommand to `scripts/lint/main.sh`,
  `scripts/format/main.sh`, `scripts/fix/main.sh`.

- **Shell** — `pnpm lint shell` and `pnpm format shell` cover POSIX sh
  under `scripts/`. **They do not cover `packages/*/scripts/*.sh`** —
  those are bash (`set -euo pipefail`), not POSIX sh. Lint locally
  with `shellcheck` if needed.

## Deploy

The browser packages have **no deploy yet** by design
(`HANDOFF.md:99-109`). `pnpm sst deploy --stage <stage>` deploys the
SFN builder (infra/builder) but not the Python service. When the
service is ready to deploy, the pattern will be:

1. Add `apps/stealth-browser/` with `kube/` overlay.
2. Build a multi-stage Docker image of `packages/stealth-browser/`
   (with patched Chrome baked in from the artifacts bucket).
3. Wire into ArgoCD via `k3s/overlays/prod/`.

None of that has been started — don't add it unless explicitly asked.

## Common operator state queries

```sh
# Which SFNs exist?
AWS_PROFILE=Personal AWS_REGION=us-west-1 \
  aws stepfunctions list-state-machines \
  --query 'stateMachines[].{name:name,arn:stateMachineArn}' --output table

# Latest 10 builder executions
AWS_PROFILE=Personal AWS_REGION=us-west-1 \
  aws stepfunctions list-executions \
  --state-machine-arn arn:aws:states:us-west-1:343487555569:stateMachine:dev-builder \
  --max-items 10 --output table

# Latest artifacts in S3
AWS_PROFILE=Personal AWS_REGION=us-west-1 \
  aws s3 ls "s3://personal-pandoks-builderartifactsbucketbucket-oawuxubt/" --human-readable
```
