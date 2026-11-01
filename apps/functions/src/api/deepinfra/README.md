# RED-SNOW on DeepInfra

Self-hosted [RED-SNOW 5.3 FLASH](https://huggingface.co/Blackfrost-AI/RED-SNOW-5.3-FLASH-NVFP4) (a
GLM-5.3-Flash fine-tune) served from a DeepInfra "Custom LLM" deployment and driven from the Claude
Code harness.

## How it fits together

DeepInfra has no SST/Pulumi/Terraform provider, so the GPU deployment cannot be an IaC resource.
Instead the SST-managed Cloudflare Worker owns its whole lifecycle: it **creates the deployment on
the first `/wake`** and scales it to zero when idle, so you pay the ~$5.38/hr (2x H200) only during
bursts. No hand-run commands mutate the deployment.

| Piece                | Where                                     | Managed by            |
| -------------------- | ----------------------------------------- | --------------------- |
| Deployment spec      | `deployment.json`                         | version control       |
| Scaler Worker + cron | `infra/red-snow.ts`, `red-snow-scaler.ts` | SST (production only) |
| GPU deployment       | DeepInfra                                 | the Worker (`/wake`)  |

The Worker:

- `POST /wake` (bearer-protected) — creates the deployment from `deployment.json` on first use, or
  scales an existing one to one instance.
- cron every 5 min — scales to zero after 30 continuous idle minutes (read from vLLM engine logs).

Teardown (deleting the deployment entirely) is done from the DeepInfra dashboard, not from this
repo.

## One-time setup

1. Set the secrets (ask for the production values):

   ```sh
   pnpm sst secret set DeepinfraApiKey <key> --stage production
   pnpm sst secret set RedSnowWakeToken <random-token> --stage production
   ```

2. Merge to `main` so the scaler Worker deploys. Its `/wake` URL is printed as the
   `redSnowScalerUrl` stack output.

3. The first `/wake` creates the deployment (first load ~12 min).

## Using it from Claude Code

RED-SNOW serves an Anthropic-compatible API at `https://api.deepinfra.com/anthropic`. Add it to
CLIProxyAPI as a Claude-format upstream (on the hub; that config is not in this repo):

```yaml
api-keys:
  claude:
    - name: deepinfra
      base-url: 'https://api.deepinfra.com/anthropic'
      keys:
        - api-key: '<DeepinfraApiKey>'
      models:
        - name: 'Pandoks/red-snow'
          alias: 'red-snow'
          is-compat: true # keep thinking blocks that have no Anthropic signature
```

Then run against your normal proxy. The `[1m]` suffix tells Claude Code the model has a 1M window;
subagents drop it and read `CLAUDE_CODE_MAX_CONTEXT_TOKENS` for a smaller window:

```sh
# main chat 1M, subagents 256k, both on the same deployment
CLAUDE_CODE_SUBAGENT_MODEL=red-snow \
CLAUDE_CODE_MAX_CONTEXT_TOKENS=262144 \
  claude --model 'red-snow[1m]'
```

To start the GPUs automatically when you open Claude Code, POST `/wake` from a `SessionStart` hook
in `~/.claude/settings.json`:

```sh
curl -s -X POST "$RED_SNOW_SCALER_URL/wake" -H "Authorization: Bearer $RED_SNOW_WAKE_TOKEN" &
```

Expect ~12 min before the first request succeeds on a cold start.

## Pinned weights

`deployment.json` pins `hf.revision` to an immutable Hugging Face commit so recreating the
deployment always fetches the same weights. Renovate bumps it via the `git-refs` custom manager in
`renovate.json` (it tracks the `main` branch of the HF repo). DeepInfra validates the revision on
create — a stale or bad sha fails fast with `Model not found`.

## Verified vs. not

Verified in testing: NVFP4 on 2x H200 with these parsers, 1M context, tool calls, thinking blocks,
subagents, a real Claude Code coding session, and that DeepInfra honors `hf.revision`. Not yet
verified end-to-end: DeepInfra's scale-to-zero restart time, the CLIProxyAPI alias wiring, and the
Worker's idle-detection against a live deployment.
