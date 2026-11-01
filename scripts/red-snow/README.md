# RED-SNOW on DeepInfra

Self-hosted [RED-SNOW 5.3 FLASH](https://huggingface.co/Blackfrost-AI/RED-SNOW-5.3-FLASH-NVFP4) (a
GLM-5.3-Flash fine-tune) served from a DeepInfra "Custom LLM" deployment and driven from the Claude
Code harness.

## Why it is split this way

DeepInfra has no SST/Pulumi/Terraform provider, so the GPU deployment cannot be an IaC resource. It
is created once with the script here. SST owns only the **autoscaler** (`infra/red-snow.ts`): a
Cloudflare Worker that starts the deployment on demand and scales it to zero when idle, so you pay
the ~$5.38/hr (2x H200) only during bursts.

| Piece                | Where                                                                      | Managed by                                  |
| -------------------- | -------------------------------------------------------------------------- | ------------------------------------------- |
| Deployment spec      | `apps/functions/src/api/deepinfra/deployment.json`                         | version control (shared by script + Worker) |
| GPU deployment       | DeepInfra                                                                  | `pnpm red-snow` (manual)                    |
| Scaler Worker + cron | `infra/red-snow.ts`, `apps/functions/src/api/deepinfra/red-snow-scaler.ts` | SST (production only)                       |

## One-time setup

1. Set the secrets (ask for the production values):

   ```sh
   pnpm sst secret set DeepinfraApiKey <key> --stage production
   pnpm sst secret set RedSnowWakeToken <random-token> --stage production
   ```

2. Merge to `main` so the scaler Worker deploys. Its `/wake` URL is printed as the
   `redSnowScalerUrl` stack output.

3. Create the deployment once (first load ~12 min):

   ```sh
   DEEPINFRA_API_KEY=<key> pnpm red-snow up
   ```

## Day-to-day

```sh
DEEPINFRA_API_KEY=<key> pnpm red-snow status   # deploy id, status, min_instances
DEEPINFRA_API_KEY=<key> pnpm red-snow wake      # start (also done by the Worker's /wake)
DEEPINFRA_API_KEY=<key> pnpm red-snow sleep     # scale to zero now
DEEPINFRA_API_KEY=<key> pnpm red-snow logs      # last 30 min of logs
DEEPINFRA_API_KEY=<key> pnpm red-snow delete    # remove entirely
```

The cron scales to zero after 30 idle minutes on its own; `sleep` is the manual override.

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

## Verified vs. not

Verified in testing: NVFP4 on 2x H200 with these parsers, 1M context, tool calls, thinking blocks,
subagents, and a real Claude Code coding session. Not yet verified end-to-end: DeepInfra's
scale-to-zero restart time, the CLIProxyAPI alias wiring, and the Worker's idle-detection against a
live deployment.
