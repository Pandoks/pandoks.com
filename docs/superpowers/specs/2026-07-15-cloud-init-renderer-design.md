# Cloud-init Renderer Design

## Goal

Remove duplicate cloud-init placeholder interpolation from the development VPS and Kubernetes VPS provisioning code.

## Design

Add a focused `infra/cloud-init.ts` module exporting `renderCloudInit(config, environment)`. The environment accepts string or undefined values. Uppercase `${NAME}` placeholders resolve from the environment; missing or undefined values preserve the existing behavior by rendering as an empty string.

Update the only two matching implementations, `infra/dev.ts` and `infra/vps/servers.ts`, to call the helper. Ordinary TypeScript template literals are outside this refactor.

## Verification

Cover known, repeated, missing, undefined, and non-uppercase placeholders with Node's test runner. Run the infra typecheck, formatting check, and repository-wide duplicate-pattern search.
