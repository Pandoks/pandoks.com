# Cloud-init Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Share cloud-init placeholder interpolation between all infrastructure callers.

**Architecture:** A focused pure function in `infra/cloud-init.ts` renders uppercase environment placeholders. Both existing callers import it, with no change to missing-value behavior.

**Tech Stack:** TypeScript, Node.js test runner, SST infrastructure

## Global Constraints

- Preserve the current uppercase placeholder grammar: `${NAME}`.
- Preserve the current behavior of rendering unknown and undefined values as an empty string.
- Do not modify ordinary TypeScript template literals.

---

### Task 1: Extract and adopt the cloud-init renderer

**Files:**

- Create: `infra/cloud-init.ts`
- Create: `infra/cloud-init.test.ts`
- Modify: `infra/dev.ts`
- Modify: `infra/vps/servers.ts`

**Interfaces:**

- Produces: `renderCloudInit(config: string, environment: Readonly<Record<string, string | undefined>>): string`

- [x] **Step 1: Write and run the failing renderer tests**

Run: `node --import jiti/register --test infra/cloud-init.test.ts`

Expected: FAIL because `infra/cloud-init.ts` does not exist.

- [x] **Step 2: Implement the renderer**

Implement a pure replacement callback using `/\$\{([A-Z0-9_]+)\}/g` and `environment[name] ?? ''`.

- [x] **Step 3: Run the renderer tests**

Run: `node --import jiti/register --test infra/cloud-init.test.ts`

Expected: all tests pass.

- [x] **Step 4: Migrate both callers**

Import and call `renderCloudInit` from `infra/dev.ts` and `infra/vps/servers.ts`.

- [x] **Step 5: Verify the refactor**

Run `pnpm check:infra`, Prettier checks, `git diff --check`, and a repository-wide search confirming the regex exists only in the helper.
