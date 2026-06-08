---
paths:
  - 'infra/runner/**'
---

# Gotchas — infra/runner/ (ephemeral EC2 job runner)

A Step Functions state machine (`infra/runner/runner.ts` →
`RunnerStateMachine`) that launches an ephemeral EC2 instance, `git clone`s
the repo, runs an **arbitrary `$.command`** via SSM, and always terminates.
It's a generic "beefy-but-slow serverless" — a self-hosted-runner / CodeBuild
analog — NOT build-specific. Renamed from `infra/builder/` (the old name
overweighted the build use case). Four runner variants:
**x86 / arm64 / gpu-x86 / gpu-arm64**, each spot or on-demand.

## File map

| File                        | Role                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `infra/runner/runner.ts`    | IAM, 4 launch templates (`makeLaunchTemplate` `:54`), SSM PAT param, the `RunnerStateMachine` (`:180`). |
| `infra/runner/ami.ts`       | EC2 Image Builder: 3 components, 4 recipes, 4 bake-infras, 4 images, lifecycle prune.                   |
| `infra/runner/step.ts`      | The state-machine JSON generator (`runnerStateMachineDefinition` `:218`).                               |
| `infra/runner/types.ts`     | Instance-type allowlists (CPU + GPU groups); the gate validates against these.                          |
| `infra/runner/ami.yaml`     | Base tools component (`name: RunnerTools` `:1`) — build-essentials/Node/AWS-CLI/uv.                     |
| `infra/runner/ami-gpu.yaml` | GPU layer component (`name: RunnerGpuTools` `:1`) — NVIDIA driver + CUDA. Templated by `{{CUDA_ARCH}}`. |

## AMI composition is LAYERED, not duplicated

- The plain `ami.yaml` is **not copied** into the GPU path — it's included as
  the **first component** of the GPU recipes (`ami.ts:147, 153`:
  `components: [runnerToolsComponent, runnerGpu*ToolsComponent]`). An Image
  Builder recipe runs its components in sequence, so a GPU AMI = base tools +
  GPU stack. **Don't re-list `ami.yaml`'s tools inside `ami-gpu.yaml`** — that
  would be real duplication that drifts.
- The CPU recipes (`ami.ts:135, 141`) get **only** `runnerToolsComponent`, so
  CPU runners never bake the multi-GB driver/CUDA they can't use. That is the
  whole reason `ami-gpu.yaml` is a separate file: to keep the GPU stack
  **optional**.

## One GPU YAML, two arches — `{{CUDA_ARCH}}`

- `ami-gpu.yaml` is a **single** templated file feeding **both** GPU
  components. The only arch difference is the CUDA keyring repo path
  (`ami-gpu.yaml:20`): `x86_64` vs `sbsa`. `ami.ts` injects it via
  `renderAmiTemplateYaml({ file: 'ami-gpu.yaml', replacements: { CUDA_ARCH: … } })`
  — `'x86_64'` at `ami.ts:116`, `'sbsa'` at `ami.ts:126`. The `cuda-toolkit`
  (`:29`) and `nvidia-open` (`:35`) package names are identical across arches.
- **`nvidia-open` is the correct driver in 2026** — open kernel modules reached
  parity (560-series+) and are NVIDIA's recommended default for the GPUs in the
  allowlist (L4/L40S/A10G/T4/H100/H200). DKMS auto-rebuilds the module on kernel
  change; the immutable+ephemeral AMI means there's no live `apt upgrade` to
  break it.

## GPU AMIs MUST bake on a GPU instance

- The bake instance type **must match the recipe arch** AND, for GPU recipes,
  **must be a GPU instance** — the AMI's `validate` phase runs `nvidia-smi`
  (`ami-gpu.yaml:61`), which only works on real hardware. Bake instances:
  `c7i.large` / `c7g.large` (CPU) and `g6.xlarge` / **`g5g.2xlarge`** (GPU)
  (`ami.ts:169, 174`).
- **`g5g.2xlarge`, not `g5g.xlarge`**, for the arm GPU bake — AWS warns the
  driver install can fail on `g5g.xlarge`'s limited memory. This "why" is NOT in
  the code (the explanatory comment was dropped); it lives here.
- A reboot is required after driver install before `nvidia-smi` works —
  handled by `RebootForDriver` (`ami-gpu.yaml:51`); Image Builder resumes the
  build on the same instance post-reboot.

## GPU service quota defaults to 0

- GPU On-Demand/Spot vCPU quotas default to **0** in most accounts. This blocks
  **both** the bake (needs `g6`/`g5g` quota to build the AMI) **and** job
  launches. Listing a no-quota family in `types.ts` is harmless — the launch
  just fails fast. `GPU_X86_INSTANCE_TYPES` carries a `// WARNING: EXPENSIVE`
  marker (`types.ts:95`) covering the H100/H200 (P5) families.

## `RUNNER_VARIANTS` is the single source of arch variation

- `step.ts:11` `RUNNER_VARIANTS` (4 entries: `suffix` / `types` /
  `templatePath`) drives **all** the repetitive state generation in lockstep:
  the `ChooseArchitecture` routing table (`:103`), the 4 `ChooseMarket<suffix>`
  states (`:113`), and the 8 `Launch{Spot,OnDemand}<suffix>` states (`:302`).
  **Add an arch = add one row**; the 3 states generate with consistent names.
- The state names (`ChooseMarketGpuX86`, etc.) exist only **after** the loops
  run — they are NOT greppable literals in `step.ts`. Trace them through the
  `${variantInstance.suffix}` template strings.

## `$resolve` order is load-bearing (no type safety)

- `runnerStateMachineDefinition` (`step.ts:218`) takes a nested
  `templates: { x86, arm64, gpuX86, gpuArm64 }`, threaded through a **positional**
  `$resolve([...]).apply([...])`. The input array order and the `.apply`
  destructure order MUST stay aligned — a mismatch silently wires one arch's
  launch-template ID into another's slot with **zero TypeScript error** (they're
  all `Input<string>`). The `templatePath` strings in `RUNNER_VARIANTS` must
  match the keys written by `AttachTemplates`.

## Resource IDs are literal, not computed — on purpose

- Every `makeRecipe`/`makeBakeInfra`/`makeLaunchTemplate` call passes an
  **explicit literal `id`** (`'RunnerRecipeGpuX86'`, etc.), never a computed
  string. These are stateful AWS resources — a shifted ID forces destroy+recreate
  of real AMIs / launch templates / the state machine. This is the same
  literal-ID convention as the rest of `infra/**` (see `conventions/infra.md`).
  **Don't "DRY" the IDs into a generated loop.**

## SSM PAT param + AMI version bump

- The GitHub cloning token lives at SSM `/runners/${STAGE_NAME}/github-cloning-pat`
  (`runner.ts:119-123`, `SecureString` from `secrets.github.PersonalAccessToken`).
  The runner fetches it at job time and `unset`s it after clone.
- **Bumping `VERSION` (`ami.ts:6`) is required to rebuild the AMI** when any
  `ami.yaml` / `ami-gpu.yaml` step changes — there's a `WARNING` comment at
  `ami.ts:6`. The lifecycle policy (`ami.ts:228`) keeps the latest 10 versions
  per recipe.
