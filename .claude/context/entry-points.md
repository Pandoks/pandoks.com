# Entry points (browser-side)

For pandoks.com entry points (Lambda handlers, Vite plugins, SST infra
imports, ArgoCD root), read `.claude/rules/architecture.md` § "Entry
points (cheat sheet)" first. This file lists the browser-side
entrypoints only.

## Python — `packages/stealth-browser/`

| Entry | File:line | Trigger |
| --- | --- | --- |
| `stealth-browser` console script | `pyproject.toml:15` → `stealth_browser/server.py:278` (`run_server`) | `uv run stealth-browser` from a terminal |
| `main()` async entry | `stealth_browser/server.py:255-275` | Called by `run_server()` via `asyncio.run(main())` |
| HTTP route table | `stealth_browser/server.py:121-227` (`_route`) | Every inbound request |
| Connection handler | `stealth_browser/server.py:230-252` (`_handle`) | Per asyncio.start_server connection |
| `SessionManager` lifecycle | `stealth_browser/session.py:76` (`SessionManager.__init__`) | Module-scope singleton created at `server.py:48`; `start()` called from `main()` at `:256` |
| Idle-expiry sweeper | `stealth_browser/session.py:254-262` (`_sweep_loop`) | Background task, scans every 30s |

### Module dependency surface (top-level imports)

- `server.py` imports `.session.SessionManager`, `.session.ServiceError`.
- `session.py` imports `.core_nodriver.NodriverCore`,
  `.core_patchright.PatchrightCore`, `stealth_browser.profile.Identity`.
- `core_nodriver.py` imports `stealth_browser.browser.StealthBrowser`,
  `stealth_browser.profile.{Identity, identity_for_ip_geo}`,
  `stealth_browser.human.Human`, `stealth_browser.runner_nodriver`,
  `stealth_browser.proxy`, `.fp_profiles`, `.personas`.
- `identity.py` re-exports from `stealth_browser.profile` —
  `Identity`, `identity_for_ip_geo`, `chrome_launch_flags`,
  `chrome_path`, `in_container` (`identity.py:19-25`).

### Backend selection

`session.py:35-63` (`_make_core`) picks `NodriverCore` vs
`PatchrightCore` from `APEX_CORE` env (default `nodriver`). Both expose
identical interfaces — `open / navigate / eval_js / click / type_text
/ scroll / screenshot / extract_text / close / dump_state /
restore_state`.

## Shell — `packages/stealth-chromium/scripts/`

| Entry | File | Triggered by |
| --- | --- | --- |
| `setup.sh` | local, fetches Chromium source (~100GB) | Operator one-time before first build; also called by `sfn-build.sh` on the EC2 builder |
| `apply.sh` | local, applies overlays + anchor edits + GN args | Operator after every patch change; also called by `sfn-build.sh` |
| `build.sh` | local, multi-hour autoninja | Operator; also called by `sfn-build.sh` |
| `apply_edits.py` | local, `--check` mode for anchor verification | Run by operator after Chromium version bumps to detect drift |
| `sfn-build.sh` | `packages/stealth-chromium/scripts/sfn-build.sh:1` | **EC2 instance, via SSM RunShellScript triggered by the SFN** — orchestrates setup → apply → build → upload artifact |
| `test_patched_binary.sh` | local | Operator post-build verification |
| `cdp_probe.py` | local Python | Single-patch debugging |

## TypeScript — `infra/builder/`

| Resource | File:line | What it produces |
| --- | --- | --- |
| `BuilderToolsComponent` | `infra/builder/ami.ts:27` | EC2 Image Builder component baked from `ami.yaml` |
| `BuilderImageX86` / `BuilderImageArm64` | `ami.ts:65, 69` | Two AMIs — Ubuntu 24 + clang/lld/ninja/ccache/depot_tools |
| `BuilderLifecyclePolicy` | `ami.ts:88` | Keeps newest 10 AMIs per arch |
| `BuilderInstanceRole` + S3 inline policy | `builder.ts:7, 19` | Per-instance IAM — S3 read/write to cache + artifacts buckets, SSM core |
| `BuilderLaunchTemplateX86` / `Arm64` | `builder.ts:41, 52` | Launch templates referenced by the SFN |
| `BuilderGithubCloningToken` (SSM SecureString) | `builder.ts:64` | GitHub PAT for `git clone` inside the build |
| `BuilderStateMachineRole` | `builder.ts:70` | SFN execution role — EC2 + SSM + iam:PassRole |
| `BuilderStateMachine` | `builder.ts:109` | The `dev-builder` / `prod-builder` SFN — calls `builderStateMachineDefinition()` for JSON definition |
| `builderStateMachineDefinition` | `infra/builder/step.ts:155` | Pure function — returns Pulumi Output of JSON-stringified ASL |
| `ARM_INSTANCE_TYPES` / `X86_INSTANCE_TYPES` | `infra/builder/types.ts:6, 41` | Whitelist consts shared between infra (validates SFN inputs) and `apps/functions/` (header `:1-5`) |

`builder.ts` is imported by `sst.config.ts:35` —
`import('./infra/builder/builder')`. Imports propagate transitively
through `builder.ts → step.ts → types.ts` and `builder.ts → ami.ts →
ami.yaml`.

## AWS Step Functions — the SFN itself

State machine ARN (us-west-1, account `343487555569`):

- Dev: `arn:aws:states:us-west-1:343487555569:stateMachine:dev-builder`
- Prod: `arn:aws:states:us-west-1:343487555569:stateMachine:prod-builder`

Trigger via `aws stepfunctions start-execution` (see `workflows.md` §
"Start a build" for the canonical command).

States, in order (`infra/builder/step.ts`):

```
ResolveInputs (Choice on rootVolumeSizeGb presence)
  → ApplyDefaultRootVolumeSize (Pass, sets 30) → PickIdSource
  → PickIdSource (Choice on $.id presence)
    → ResolveInputsWithId (Pass, forwards $.id) → ChooseArchitecture
    → ResolveInputsWithExecutionId (Pass, uses $$.Execution.Name) → ChooseArchitecture
ChooseArchitecture (Choice on instanceType match against ARM ∪ X86 lists)
  → ChooseMarketX86 (Choice on marketType) → LaunchSpotX86 | LaunchOnDemandX86
  → ChooseMarketArm64 (Choice on marketType) → LaunchSpotArm64 | LaunchOnDemandArm64
  → FailInvalidInstanceType (Fail)
Launch{Spot,OnDemand}{X86,Arm64} (Task ec2:runInstances)
  → WaitForSSM | FailNoInstance
WaitForSSM (60s Wait) → CheckSSMReady (ssm:describeInstanceInformation)
  → IsSSMReady (Choice on PingStatus) → WaitForSSM (loop) | RunBuild
RunBuild (Task ssm:sendCommand, executionTimeout=86400)
  → WaitForBuild | TerminateAfterFailure
WaitForBuild (60s Wait) → CheckBuildStatus (ssm:getCommandInvocation)
  → IsBuildDone (Choice on Status)
    → Success → TerminateAfterSuccess → Done (Succeed)
    → Failed/Cancelled/TimedOut → TerminateAfterFailure → FailBuild (Fail)
```

## S3 buckets (browser-side)

| Resource | Where defined | Purpose |
| --- | --- | --- |
| `builderArtifactsBucket` | `infra/storage.ts` (imported at `infra/builder/builder.ts:3`) | Patched binary uploads, build-failure logs, manifests |
| `builderCacheBucket` | `infra/storage.ts` | Chromium source tarball + ccache (warm-build acceleration) |

Stage `dev` resolves to physical names like
`personal-pandoks-builderartifactsbucketbucket-oawuxubt` (the suffix is
SST-generated).

## SSM parameters

`/builders/<stage>/github-cloning-pat` (SecureString, KMS-encrypted) —
set at `infra/builder/builder.ts:64-68`. Value sourced from
`secrets.github.PersonalAccessToken`. The SFN bash at `step.ts:187`
reads it via `aws ssm get-parameter --with-decryption` and unsets the
env immediately after the clone.

## CloudWatch logs

- `/aws/ssm/AWS-RunShellScript` — all SSM-RunShellScript output for
  the entire AWS account. Filter with `--filter-pattern "$BUILD_ID"`
  to find a specific run's logs (`stealth-chromium/README.md:241-243`).
- The build's own log file (`/tmp/stealth-chromium-build-${BUILD_ID}.log`)
  is created on the EC2 instance via `sfn-build.sh:25-26` (`exec > >(tee
  -a ...)`). Last 1MB uploaded to S3 on failure (`:35-41`).
