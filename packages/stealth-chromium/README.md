# `@pandoks.com/stealth-chromium`

Native C++ fingerprint patches for Chromium &mdash; a **`chromium_src` overlay
+ anchor-edit set**, not a fork. Spoofs canvas, WebGL, audio, navigator,
screen, fonts, WebRTC, and the V8 inspector at the engine level, so there is
**no JS-visible tampering** for a fingerprinter to catch.

Pairs with [`@pandoks.com/stealth-browser`](../stealth-browser/) &mdash; the
Python service auto-detects the patched binary via `APEX_CHROME_PATH` and
flips on per-session spoofing via `APEX_FP_*` env vars (`Active()` master
switch).

> **Heads up &mdash; legacy naming.** Internals still use the `apex_` /
> `APEX_FP_` / `APEX_CHROMIUM_WORK` prefixes from when this code lived in
> `~/Projects/sandbox/apex-chromium/`. Renaming was deferred because an
> in-flight v2 build still references those exact strings. New code should
> match the existing prefix.

## Why C++ and not a JS shim

A JS stealth plugin overrides a getter (`Object.defineProperty` on
`CanvasRenderingContext2D.prototype`, etc.). Fingerprinters &mdash; CreepJS's
`stealth` detector specifically &mdash; catch *the act of overriding*: the
patched function has a different `Function.prototype.toString` (`"[native code]"`
is gone) and anomalous property descriptors. A JS patch lowers your score.

A C++ patch changes the value the engine itself returns. The JS getter stays
pristine &mdash; `toString` still says `[native code]`, descriptors are
normal &mdash; because nothing in JS was touched. The value *is* the engine's
value.

## How the patches are organized (3 mechanisms)

This is the part that's surprised every reader so far. There are **three**
ways a patch can land, and you need to know which one for each surface.

| # | Mechanism | When to use | Where it lives | Count |
|---|---|---|---|---|
| 1 | **Full-file `chromium_src/` overlay** | The upstream `.cc` is a single tiny function. Drop in a complete replacement. | `chromium_src/<path>/<file>.cc` + listed in `scripts/apply.sh` `OVERLAYS=()` | 2 |
| 2 | **Anchor edit** (preferred for everything else) | Patch one function inside a multi-function file. A unique substring anchors the insertion, surviving Chromium version drift. | A dict in the `EDITS = [...]` list at `scripts/apply_edits.py` | 30 |
| 3 | **`.patch` file** (documentation only) | None &mdash; the `.patch` files in `patches/` are vestigial. They describe historical intent. `apply.sh` does **not** apply them. | `patches/*.patch` + `patches/series` | 11 (informational) |

The header at the top of `scripts/apply.sh` claims it applies the `.patch`
files in step 3 &mdash; **that comment is wrong**. Step 3 writes GN args. The
real patching is steps 0&ndash;2 (shared headers + full-file overlays +
anchor edits). If you find yourself reading `patches/*.patch` to understand
current behavior, stop &mdash; read `apply_edits.py` instead.

### `apply_edits.py` &mdash; the anchor-edit schema

```python
{
  "file": "third_party/blink/renderer/<path>/<file>.cc",
  "header": '#include "<helper-header.h>"',   # optional: ensures this #include exists
  "marker": "apex-<short-name>",              # unique; makes the edit idempotent
  "anchor": "the EXACT code substring after which (or before which) to insert.\n"
            "Must be unique in the file. Multi-line strings supported.\n",
  "where": "after" | "before" | "after-block",
  "inject": "the C++ code to splice in. By convention starts with\n"
            "  // <marker>\n"
            "so future-you can grep for it.",
}
```

- `where: "after"` &mdash; splice right after the anchor.
- `where: "before"` &mdash; splice right before the anchor.
- `where: "after-block"` &mdash; splice after the function's opening brace
  (useful when the anchor matches a function signature and you want the
  edit at the top of the function body).
- Run `python3 scripts/apply_edits.py --check` &mdash; verifies every anchor is
  findable in the current checkout without mutating anything. Use this after a
  Chromium version bump to find drifted anchors.

### Shared headers (step 0 of `apply.sh`)

`chromium_src/apex_fingerprint.h` is the shared library used by every patch
(env-var parsing + `Active()` master switch + `EtldSeed()` per-site seed +
mulberry32 PRNG). `apply.sh` copies it into every Blink module dir that
needs it, plus the V8 inspector. **If you add a patch in a module dir not
already on the list, extend the `for dir in ... ; do` block at line ~33 of
`apply.sh`.**

Module-local helper headers (e.g. `apex_canvas_noise.h`,
`apex_text_metrics_noise.h`) live alongside the files they patch and are
copied in step 0 alongside `apex_fingerprint.h`.

## Adding a new patch &mdash; worked example

Say you want to spoof `navigator.maxTouchPoints` to make the browser look
like a touch device.

1. **Find the upstream file.** Grep
   `$APEX_CHROMIUM_WORK/chromium/src/third_party/blink/renderer/` for
   `maxTouchPoints` &mdash; usually leads to a method in `navigator_ua.cc`,
   `navigator.cc`, or similar.
2. **Choose the mechanism.** Single tiny function in a single-function file
   &rarr; full-file overlay. Multi-function file &rarr; anchor edit. Most new
   patches will be anchor edits.
3. **Write the patch.** For anchor edits, add an entry to `EDITS` in
   `scripts/apply_edits.py`:
   ```python
   {
     "file": "third_party/blink/renderer/core/frame/navigator_ua.cc",
     "header": '#include "apex_fingerprint.h"',
     "marker": "apex-max-touch-points",
     "anchor": "int NavigatorUA::maxTouchPoints() const {\n",
     "where": "after",
     "inject": "  // apex-max-touch-points\n"
               "  if (apex_fp::HasOverride(\"APEX_FP_MAX_TOUCH_POINTS\")) {\n"
               "    int v = apex_fp::EnvInt(\"APEX_FP_MAX_TOUCH_POINTS\", 0);\n"
               "    if (v >= 0 && v <= 10) return v;\n"
               "  }\n",
   }
   ```
4. **Add a probe row** to `scripts/verify_patches.html` so
   `test_patched_binary.sh` checks it after the build.
5. **Wire the env var** into `packages/stealth-browser/stealth_browser/fp_profiles.py`
   if you want it set automatically from device profiles (otherwise callers
   set `APEX_FP_MAX_TOUCH_POINTS` themselves).
6. **Verify the anchor** without rebuilding:
   `APEX_CHROMIUM_WORK=$WORK python3 scripts/apply_edits.py --check`.
7. **Rebuild.** Multi-hour; see "Run" below.

### `APEX_FP_*` env-var convention

- All-caps, underscore-separated. Prefix: always `APEX_FP_`.
- Read via `apex_fp::EnvStr` / `EnvInt` / `EnvDouble` / `EnvU32`
  (defined in `chromium_src/apex_fingerprint.h`).
- Gate every override with `if (apex_fp::HasOverride("APEX_FP_FOO")) { ... }`
  &mdash; this returns true only when `Active()` is true *and* the specific
  env var is non-empty. **Don't** gate only on `Active()` unless the surface
  is one that should always be perturbed when apex is on (canvas/audio
  noise are the only existing examples).
- Validate the value before returning it &mdash; absurd values are a bigger
  fingerprint than no override at all.

## Run

Two paths: **on your own machine** (long, but you keep the checkout) or
**via the AWS SFN builder** (ephemeral, parallelizable, artifact in S3).

### Local

```sh
cd packages/stealth-chromium

# 1. Fetch ~100GB Chromium source (one-time)
APEX_CHROMIUM_WORK=/Volumes/X9Pro/apex-chromium-build scripts/setup.sh

# 2. Apply overlays + anchor edits to the checkout (fast, idempotent)
APEX_CHROMIUM_WORK=/Volumes/X9Pro/apex-chromium-build scripts/apply.sh

# 3. Build (multi-hour first time; subsequent ones are incremental)
APEX_CHROMIUM_WORK=/Volumes/X9Pro/apex-chromium-build scripts/build.sh
```

The output binary lives at
`$APEX_CHROMIUM_WORK/chromium/src/out/apex/Chromium.app/Contents/MacOS/Chromium`
(macOS) or `$APEX_CHROMIUM_WORK/chromium/src/out/apex/chrome` (Linux). Point
the stealth-browser service at it via
`APEX_CHROME_PATH=/path/to/Chromium`.

### Via the AWS SFN builder (recommended for fresh builds)

The monorepo ships an ephemeral EC2 builder defined under
[`infra/builder/`](../../infra/builder/). It launches a fresh c7i / c7g
instance from a pre-baked AMI (clang, lld, ninja, ccache, depot_tools deps
pre-installed), runs the build in a managed Step Functions workflow with
SSM-streamed CloudWatch logs, uploads the patched binary to S3, and
terminates the instance &mdash; even on failure.

The first build is cold &mdash; expect **6&ndash;10 hours** on a 4xlarge.
Subsequent builds restore the Chromium source tree + ccache from
`BUILDER_CACHE_BUCKET` and complete in **30&ndash;90 minutes**.

**Prerequisites** (one-time):

- AWS SSO access to the account hosting the builder
  (we use `AWS_PROFILE=Personal` against `us-west-1`).
- The `dev-builder` (or `prod-builder`) state machine must be deployed.
  If it isn't, `cd` to the repo root and run `pnpm sst deploy --stage dev`
  &mdash; that provisions VPC, IAM, launch templates, S3 buckets, and the
  state machine itself in one pass.
- The branch with your code **must be pushed to GitHub** &mdash; the SFN
  does `git clone --branch <ref>` from origin. Local-only branches are
  invisible.

**Start a build:**

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

Pick `instanceType` from the lists in
[`infra/builder/types.ts`](../../infra/builder/types.ts). The architecture
gate routes you to the matching launch template automatically (c7g.\* /
c8g.\* / m\*g.\* &rarr; arm64; c7i.\* / c8i.\* / m\*i.\* &rarr; x86).
`marketType: "spot"` is ~4&times; cheaper but can be interrupted; for the
multi-hour Chromium build use `"on-demand"` unless you've already cached
the checkout.

**`rootVolumeSizeGb`** sizes the EC2 instance's root EBS volume for this
run. The default (when omitted) is **30 GB** &mdash; intentionally small,
so a quick smoke build doesn't overpay. **For a Chromium build you must
pass at least 200 GB** (~100 GB source checkout + ~30 GB build output +
ccache + tarball staging). The volume has `DeleteOnTermination: true`, so
it disappears with the instance and bills nothing between runs. gp3 at
$0.08/GB-month works out to ~$0.022/hr while the build is running &mdash;
trivial compared to the instance cost itself.

**Monitor the build:**

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

# live build log (the SSM-RunShellScript task streams to CloudWatch)
aws logs tail "/aws/ssm/AWS-RunShellScript" --follow \
  --filter-pattern "$BUILD_ID"
```

**Fetch the artifact:**

```sh
ARTIFACTS_BUCKET=personal-pandoks-builderartifactsbucketbucket-oawuxubt
aws s3 cp "s3://${ARTIFACTS_BUCKET}/${BUILD_ID}/manifest.json" - | jq .
aws s3 cp "s3://${ARTIFACTS_BUCKET}/${BUILD_ID}/chromium-148.0.7778.179.tar.zst" .
tar --use-compress-program 'zstd -d --long=27' -xf chromium-148.0.7778.179.tar.zst -C /opt/stealth-chromium/
export APEX_CHROME_PATH=/opt/stealth-chromium/chrome
```

**Diagnose a failure:** `sfn-build.sh` traps `ERR` and uploads the last
1MB of the build log to `s3://<artifacts>/<BUILD_ID>/build-failure.log`
*before* the SFN terminates the instance &mdash; so the diagnostic survives
the cleanup. Pull it with `aws s3 cp` and grep for `ANCHOR NOT FOUND`,
`ld64.lld`, `error:`, etc.

**Cost ballpark** (us-west-1):

| step | duration | cost |
|---|---|---|
| cold first build (c7i.4xlarge on-demand, no cache) | ~7h | ~$5 |
| warm incremental (cache HIT for src + ccache) | ~45min | ~$0.55 |
| spot variant (c7i.4xlarge spot, no cache) | ~7h | ~$1.40 |

S3 storage for the Chromium-src tarball (~6 GB compressed) + ccache
tarball (~12 GB compressed) is ~$0.40/mo at standard pricing.

### Env var naming note

The build scripts and C++ patches use the `APEX_*` prefix
(`APEX_CHROMIUM_WORK`, `APEX_FP_*`) &mdash; legacy from when this code
lived in `~/Projects/sandbox/apex-chromium/`. It has NOT been renamed to
`STEALTH_*` because an in-flight v2 build still references those exact
strings. New code should match the existing `APEX_*` prefix.

## Verify

```sh
# After build, on the host:
scripts/test_patched_binary.sh
```

Loads `scripts/verify_patches.html` in the patched binary with
`APEX_FP_*` set; every patched surface gets a green PASS row + a
`toString()` native-code integrity check.

For raw-CDP probing of the binary outside the browser (used during
development to verify a single patch):

```sh
uv run --project ../stealth-browser python scripts/cdp_probe.py
```

## What's already patched

`apply.sh` + `apply_edits.py` together cover (truthful count: **2 overlays +
30 anchor edits = 32 distinct edits**, spanning ~24 web-facing surfaces):

| Surface | Mechanism | Env var(s) |
|---|---|---|
| `navigator.hardwareConcurrency` | overlay | `APEX_FP_HARDWARE_CONCURRENCY` |
| `navigator.deviceMemory` | overlay | `APEX_FP_DEVICE_MEMORY` |
| `navigator.userAgentData.platform` | anchor edit | `APEX_FP_UA_PLATFORM` |
| `navigator.platform` | anchor edit | `APEX_FP_PLATFORM` |
| `screen.{width,height,availWidth,availHeight,colorDepth}` | anchor edit | `APEX_FP_SCREEN_*` |
| WebGL `UNMASKED_VENDOR` / `UNMASKED_RENDERER` | anchor edit | `APEX_FP_WEBGL_*` |
| WebGL `readPixels` (per-session pixel noise) | anchor edit + `apex_canvas_noise.h` | `APEX_FP_SEED` (master) |
| Canvas `getImageData` (per-session pixel noise) | anchor edit + `apex_canvas_noise.h` | `APEX_FP_SEED` |
| Canvas `toDataURL`/`toBlob` encode path | anchor edit | `APEX_FP_SEED` |
| Canvas `measureText` (per-session metric farbling) | anchor edit + `apex_text_metrics_noise.h` | `APEX_FP_SEED` |
| WebAudio `getChannelData` (per-session sample offset) | anchor edit + `apex_audio_noise.h` | `APEX_FP_SEED` |
| Battery API (`level`/`charging`/`*Time`) | anchor edit | `APEX_FP_BATTERY_*` |
| SpeechSynthesis voice list | anchor edit + `apex_voices.h` | `APEX_FP_UA_PLATFORM` |
| `MediaDevices.enumerateDevices` | anchor edit + `apex_devices.h` | `APEX_FP_SEED` |
| Local Font Access (`queryLocalFonts`) | anchor edit + `apex_font_policy.h` | `APEX_FP_ACTIVE` |
| WebRTC ICE (no-non-proxied-UDP, real-IP leak) | anchor edit | `APEX_FP_ACTIVE` |
| V8 inspector console-preview (2026 CDP-detection vector) | anchor edit | `APEX_FP_ACTIVE` |
| `navigator.connection.{effectiveType,rtt,downlink}` | anchor edit (×3) | `APEX_FP_NET_EFFECTIVE_TYPE` / `APEX_FP_NET_RTT` / `APEX_FP_NET_DOWNLINK` |
| `navigator.storage.estimate().quota` | anchor edit | `APEX_FP_STORAGE_QUOTA` |
| `getBoundingClientRect`/`getClientRects` (per-session sub-pixel jitter) | anchor edit | `APEX_FP_SEED` |
| `Sec-CH-UA-Platform[-Version]` headers (coherent with userAgentData) | anchor edit (×2) | `APEX_FP_UA_PLATFORM` / `APEX_FP_UA_PLATFORM_VERSION` |

`patches/*.patch` files describe these in unified-diff form for review
purposes but are NOT executed by the build.

## Deferred / not yet implemented

- RAF + audio-quantum timing jitter (Chrome already clamps
  `performance.now()` to 100&micro;s; need empirical evidence we need more).
- Per-eTLD+1 reseeding (Brave's per-site noise diversity). The
  `EtldSeed(host)` helper exists in `apex_fingerprint.h` but no patch
  consumes it yet.

## Operator state &amp; in-flight builds

See [`../stealth-browser/HANDOFF.md`](../stealth-browser/HANDOFF.md) for the
current state of the v2 build (last failure log location, what's been
tried, whether the v1 binary is usable).
