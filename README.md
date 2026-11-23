<div align="center">
  <a href="https://pandoks.com">
    <img src="./apps/web/static/favicon/favicon.svg" alt="Pandoks" width="96" height="96">
  </a>

  <h1>Pandoks</h1>

  <p>
    Everything Pandoks, in one monorepo.<br>
    Applications, infrastructure, clusters, automation, and development tooling.
  </p>

  <p>
    <a href="https://github.com/Pandoks/pandoks.com/actions/workflows/pipeline.yaml"><img src="https://github.com/Pandoks/pandoks.com/actions/workflows/pipeline.yaml/badge.svg" alt="Pipeline"></a>
    <a href="https://github.com/Pandoks/pandoks.com/actions/workflows/security-audit.yaml"><img src="https://github.com/Pandoks/pandoks.com/actions/workflows/security-audit.yaml/badge.svg" alt="Security Audit"></a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/Node.js-24-5FA04E?logo=nodedotjs&logoColor=white" alt="Node.js 24">
    <img src="https://img.shields.io/badge/pnpm-12-F69220?logo=pnpm&logoColor=white" alt="pnpm 12">
    <img src="https://img.shields.io/badge/Pulumi-IaC-8A3391?logo=pulumi&logoColor=white" alt="Pulumi">
    <img src="https://img.shields.io/badge/K3s-Kubernetes-FFC61C?logo=k3s&logoColor=black" alt="K3s">
    <img src="https://img.shields.io/badge/mise-toolchain-8B5CF6" alt="Managed with mise">
  </p>

  <p>
    <a href="#getting-started">Getting Started</a> ·
    <a href="#local-kubernetes">Local Kubernetes</a> ·
    <a href="#infrastructure">Infrastructure</a> ·
    <a href="#bootstrap">Bootstrap</a>
  </p>
</div>

---

| Directory    | Contents                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| `apps/`      | Deployable apps (`web`, `functions`, `example`)                                                                |
| `packages/`  | Shared libraries, Helm charts & images (`svelte`, `postgres`, `clickhouse`, `valkey`, `argocd`, `e2e`)         |
| `templates/` | Starter apps (`desktop`, `mobile`, never deployed)                                                             |
| `infra/`     | [Pulumi](https://www.pulumi.com/docs/) cloud infrastructure (AWS, Cloudflare, Hetzner, OVH, Tailscale, GitHub) |
| `k3s/`       | Kustomize overlays & ArgoCD config ([k3s/README.md](./k3s/README.md))                                          |
| `scripts/`   | Setup, bootstrap, lint/format & cluster CLI ([scripts/cluster/README.md](./scripts/cluster/README.md))         |

## Getting Started

**Prerequisites:** [Git](https://git-scm.com/downloads),
[mise](https://mise.jdx.dev/installing-mise.html), [Docker](https://docs.docker.com/get-docker/),
and _(cloud clusters only)_ [Tailscale](https://tailscale.com/download).

```sh
./scripts/setup.sh
```

Installs `mise` tools and `pnpm` dependencies, configures/signs into `pandoks-dev` AWS SSO, sets up
the Pulumi R2 state profile, and verifies access (idempotent — rerun anytime). Developers only need
an IAM Identity Center login for `pandoks-dev` — no Cloudflare, Hetzner, or production AWS
credentials.

> [!NOTE]
> AWS SSO sessions expire every 12 hours — run `pnpm sso` to refresh.

## Local Kubernetes

Run a local K3s mirror in Docker with [k3d](https://k3d.io/) (`local` reads shared outputs from the
`dev` stack):

```sh
pnpm local:init      # Start deps, create k3d cluster, build/push images, bootstrap & deploy
pnpm local:destroy   # Tear down cluster and local dependencies
```

<details>
<summary><strong>Step-by-step local cluster commands</strong></summary>

---

```sh
pnpm cluster k3d deps up               # Start docker compose dependencies
pnpm cluster k3d up                    # Create k3d cluster
pnpm local:build && pnpm local:push    # Build and push images/charts to local registry
pnpm cluster deploy local --bootstrap  # First-time: install helm charts + CRDs
pnpm cluster deploy local              # Apply local overlay
```

---

</details>

More docs: [scripts/cluster/README.md](./scripts/cluster/README.md) ·
[k3s/README.md](./k3s/README.md) · [packages/e2e/README.md](./packages/e2e/README.md)

## Infrastructure

`infra/` is a Pulumi program backed by Cloudflare R2 state (`Pulumi.yaml`), with each stack's
secrets KMS-encrypted and pinned to its AWS account via `aws:allowedAccountIds`:

- **`production`** (`pandoks-production`, committed) — full prod infra, deployed only by GitHub
  Actions on `main`.
- **`dev`** (`pandoks-dev`, committed) — shared by personal stacks, PR previews, and local clusters
  (dev K3s cluster, EC2 runner AMIs, R2 backups, `dev` GitHub environment).
- **Personal stacks `<name>`** (`pandoks-dev`, gitignored) — isolated per-dev app resources
  (`<name>-*`, `api.<name>.pandoks.com`) on top of `dev`'s shared infra.

```sh
# Preview & deploy (defaults to AWS_PROFILE=pandoks-dev via mise.toml)
pulumi preview --stack <stack>
pulumi up --stack <stack>

# Initialize a personal stack (copies aws:allowedAccountIds & non-prod secrets from dev)
pulumi stack init <name> --no-select \
  --secrets-provider 'awskms://alias/pulumi-nonproduction?region=us-west-1' \
  --copy-config-from dev

# Set secrets (--raw < <file> for multiline keys)
pulumi config set --secret --stack <stack> <Name>
AWS_PROFILE=pandoks-production pulumi config set --secret --stack production <Name>
```

> [!TIP]
> Personal stack files stay gitignored — `pulumi config refresh --stack <name>` restores them from
> state. `production` and `dev` secrets ship via PR.

## Bootstrap

**Admin-only** one-time setup for the production (`pandoks-production`) and non-production
(`pandoks-dev`) AWS accounts (idempotent — rerun anytime; developers use `./scripts/setup.sh`
instead):

```sh
pnpm bootstrap
```

- **`pandoks-production`** (production)
  - Cloudflare R2 state bucket (`pandoks-pulumi-state`)
  - KMS key `alias/pulumi-production`
  - SSM R2 tokens (`/pulumi/r2-state-credentials`, `/pulumi/r2-state-read-credentials`)
  - GitHub OIDC provider, `PandoksGithubActions` CI role, and repo vars (`AWS_ROLE_ARN`,
    `AWS_REGION`)
- **`pandoks-dev`** (non-production)
  - KMS key `alias/pulumi-nonproduction`
  - SSM R2 token (`/pulumi/r2-state-credentials`)
- **Local**
  - `~/.aws/config` profile `pandoks-pulumi-state`

<details>
<summary><strong>AWS Organizations &amp; IAM Identity Center (SSO) setup</strong></summary>

---

> **AWS terms**
>
> - **Management account:** top-level account for billing, AWS Organizations, and IAM Identity
>   Center (`us-west-1`) — runs no workloads.
> - **Member accounts (`pandoks-production`, `pandoks-dev`):** hard-siloed child accounts under the
>   management account; resources and permissions never cross accounts.
> - **SSO users:** personal logins (with MFA) used to access member accounts — always add an **SSO
>   user** for new developers, never a new AWS account (CI uses OIDC, not SSO).

#### 1. Initial AWS Setup (once)

1. Create an AWS **management account**, open **AWS Organizations → AWS accounts**, and create two
   member accounts (`pandoks-production` and `pandoks-dev`, unique root email alias each).
2. Enable **IAM Identity Center** in `us-west-1` and create the `AdministratorAccess` permission set
   (plus `ReadOnlyAccess` if needed).
3. Put each member account's 12-digit ID in `aws:allowedAccountIds` in `Pulumi.production.yaml` and
   `Pulumi.dev.yaml`, then run `pnpm bootstrap`.

#### 2. Add a Developer (SSO user)

1. In **IAM Identity Center** (`us-west-1`) → **Users → Add user**.
2. Assign their user `AdministratorAccess` on **`pandoks-dev`** (no access on `pandoks-production`,
   or `ReadOnlyAccess` for logs; admins get `AdministratorAccess` on both).
3. Add them to the GitHub repo (and Tailscale if they need cloud `dev` cluster access).
4. On their laptop, they run `./scripts/setup.sh` — it writes the `pandoks-dev` AWS SSO profile
   automatically and prompts only for the browser SSO sign-in.

---

</details>

## If a production secret leaks

A leak exposes every production Pulumi secret (`infra/secrets.ts`), so rotate every credential among
them. Do these steps in order: GitHub accounts and keys come out with the PATs and other footholds
after **Close the source**, all before **Rotate**, so the attacker can't watch or undo the rotation,
and only what needs the new values waits for **Deploy**.

1. **Delete the PATs.** Delete the tokens in `GithubPersonalAccessToken` and
   `GithubPackageManagementToken` (GitHub → Settings → Developer settings → Personal access tokens)
   before anything else, and make no new ones until **Rotate**. Pulumi manages this repo with the
   first and writes it as `GH_TOKEN`, so anyone holding it can open the `production` environment to
   another branch and read its secrets. Renovate, the internet-facing `NotionWebhookHandler` Lambda,
   the cluster's `ghcr-auth` Secrets, and SSM's `/runners/prod/github-cloning-pat`, which any runner
   job can read, hold it too. The second can delete GHCR package versions. Then remove
   collaborators, invitations, deploy keys, webhooks, self-hosted runners, and account SSH and GPG
   keys you didn't add, since any of them can merge to `main` or push. Cancel every run that isn't
   finished, and repeat until the loop prints nothing: a running `id-token: write` job can keep
   assuming the AWS role.

   ```sh
   for run_status in requested queued pending waiting in_progress; do
     gh run list --status "${run_status}" --limit 1000 --json databaseId --jq '.[].databaseId'
   done
   gh run cancel <id>
   ```

2. **Close the source.** Before any new value exists:
   - Review `main`'s merged commits and PRs since the leak, and its Activity view for force pushes.
     The `main` ruleset requires no approvals, so a PAT holder can merge.
   - Remove the leaking dependency or input from `main` by PR and merge it, dispatching nothing
     before then: `deploy-pulumi` installs it beside every secret. Deploys fail until **Rotate**,
     since the GitHub provider looks up `GH_TOKEN`'s user and gets 401 for the deleted PAT, so
     **Deploy**'s is the first that lands.
   - If this machine ever installed the bad version, it may have persisted outside `node_modules`
     (shell rc files, `~/.aws/config`, git hooks, mise config), so run every later step from a clean
     machine.
   - In a new terminal, which every later step uses, update to the fixed `main` and run
     `pnpm install --frozen-lockfile`. A leftover dependency's `node` or `pulumi` binary on `PATH`
     would otherwise intercept secrets during **Rotate**.

3. **Remove access.** Remove what the attacker can still act through, back to the leak's start:
   - **AWS:** first rerun step 1's cancel, since a workflow scheduled on `main` before step 2's
     merge can start a run, then close access to production's Pulumi stack and KMS key:
     - IAM → Roles → `PandoksGithubActions` → Revoke sessions: undoing its trust policy leaves
       credentials it already issued valid.
     - IAM → Users → `argo-cmp` → Security credentials: delete its access key, which reads
       `/pulumi/r2-state-read-credentials` and decrypts stack outputs with
       `alias/pulumi-production`. **Deploy** makes a new one. Argo can't render prod until then.
     - SSM Parameter Store → replace `/pulumi/r2-state-credentials` and
       `/pulumi/r2-state-read-credentials` with new R2 API tokens, then delete the old R2 tokens in
       Cloudflare (note: if `pandoks-dev` was also exposed, rotate `/pulumi/r2-state-credentials`
       there too).

     Then, in CloudTrail →
     [Event history](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/view-cloudtrail-events.html)
     (90 days, per Region), check every enabled Region, not just those in use, since
     `PandoksGithubActions` has `AdministratorAccess`. If the leak is older than 90 days and no
     trail kept its events, treat every IAM principal and resource you can't account for as the
     attacker's. Undo every write you didn't make: IAM users, keys, roles, identity providers, that
     role's trust policy, bucket policies, instances, functions, and anything else, and revoke the
     role's sessions again if its trust policy changed. Because Pulumi state lives in Cloudflare R2
     (`pandoks-pulumi-state`, object `.pulumi/stacks/pandoks.com/production.json`), also check
     Cloudflare Audit Logs for unexpected R2 token or bucket activity and inspect state if
     `PandoksGithubActions` or R2 tokens were abused.

   - **GitHub:** check the repo's Actions secrets and variables (a changed `AWS_ROLE_ARN` would send
     **Deploy**'s credentials to another account), the `main` ruleset, and GHCR package versions
     pushed or deleted since the leak, above all the tags prod pulls on every start:
     `argocd-pulumi-plugin:main`, beside the AWS key, and the example app's `:latest` images, beside
     the database and backup keys. Republish any that changed from trusted `main` and check their
     digests; **Deploy** restarts what runs them. Check `production`'s branch policy: the first
     command must print `{"custom_branch_policies":true,"protected_branches":false}`, and the second
     only `branch main`.

     ```sh
     gh api 'repos/{owner}/{repo}/environments/production' --jq .deployment_branch_policy
     gh api --paginate 'repos/{owner}/{repo}/environments/production/deployment-branch-policies' \
       --jq '.branch_policies[] | "\(.type) \(.name)"'
     ```

   - **Servers:** review each server's actions since the leak: Hetzner's `/servers/{id}/actions`
     (`create_image`, `enable_rescue`, `reset_password`, `request_console`, `attach_iso`,
     `rebuild_server`) and OVH's `/vps/{serviceName}/tasks` (`createSnapshot`, `setNetboot`,
     `reinstallVm`, `openConsoleAccess`, `getConsoleUrl`, `changeRootPassword`,
     `restoreVeeamBackup`, `restoreFullVeeamBackup`). A snapshot download and a mounted backup leave
     no task, so also check OVH's `…/snapshot` and `…/veeam/restoredBackup`. Isolate or power off
     any server with an action you didn't run, and treat its data, and any snapshotted or backed-up
     disk's, as read. Delete every Hetzner project resource you didn't make (servers, networks,
     firewalls, load balancers, volumes, IPs, placement groups, snapshots, and `/ssh_keys`), and OVH
     snapshots and `/me/sshKey` entries. Production has no Hetzner nodes; its one server is the
     imported OVH `OvhDevVps`, `vps-54c42746.vps.ovh.us`.
   - **OVH account:** the leaked consumer key can create access that outlives **Rotate**. In the
     signed-in [API console](https://api.us.ovhcloud.com/console), delete each of these you didn't
     make by its `DELETE` route: OAuth2 clients (`/me/api/oauth2/client/{clientId}`, beta), IAM
     users and their tokens (`/me/identity/user/{user}` and `…/token/{name}`), the SAML identity
     provider (`/me/identity/provider`), IAM policies (v2 `/iam/policy/{policyId}`), and
     applications (`/me/api/application/{applicationId}`, listed by `GET /me/api/application`).
   - **Tailscale:** the root OAuth client in `TailscaleOauthClient*` can make credentials and
     devices that reach every tailnet node, so revoke it first; **Rotate** makes its replacement.
     Then, under
     [Settings → Trust credentials](https://console.tailscale.com/admin/settings/trust-credentials),
     revoke every other OAuth client or federated identity you didn't make, and Pulumi's
     `prod github ci` and `prod k8s operator`, whose secrets leaked too: a `tag:ci` node reaches the
     prod cluster API as `argocd-deployer`, which can patch Argo `Application`s. **Deploy** makes
     new ones, and CI's Argo refresh fails until then. Revoking a client leaves the auth keys and
     child credentials it made, which configuration audit logs list with its client ID as the actor,
     so revoke those under [Settings → Keys](https://console.tailscale.com/admin/settings/keys).
     Revoking a key leaves its devices, so remove the ones you didn't add under
     [Machines](https://console.tailscale.com/admin/machines). Pulumi doesn't manage DNS
     nameservers, webhooks, or log streaming, so undo changes there.
   - **Cloudflare:** delete API tokens and R2 tokens you didn't make, found in the account's
     [Audit Logs](https://developers.cloudflare.com/fundamentals/account/account-security/review-audit-logs/)
     (18 months).
   - **Twilio:** `TwilioAuthToken` can make API keys and subaccounts that keep working after
     **Rotate**. Under View Subaccounts, close any subaccount you didn't make, and rotate the Auth
     Token of each you keep
     ([contain](https://www.twilio.com/docs/usage/fraud-response-guide/contain)). In the main
     account and each kept subaccount, open Settings → Account settings → API keys & auth tokens →
     API keys, and delete each key you didn't make: its name → Delete this key → Delete
     ([API keys](https://www.twilio.com/docs/iam/api-keys/keys-in-console)). Check that the phone
     number's and the messaging service's webhook URLs are still yours.

4. **Rotate.** First list `PandoksGithubActions`'s `AssumeRoleWithWebIdentity` events since you
   revoked its sessions; the rest of **Remove access** gave CloudTrail time to deliver them. One
   from a run you didn't start used an OIDC token fetched before the cancel, which works until it
   expires, so revoke again, undo what that session wrote, and repeat this check. Then set a new PAT
   in `GithubPersonalAccessToken` and `GithubPackageManagementToken`, and rotate every other secret
   in `infra/secrets.ts` (except the provider-generated items below) into `Pulumi.production.yaml`:

   ```sh
   AWS_PROFILE=pandoks-production pulumi config set --secret --raw --stack production <Name> < <secret-file>
   ```

   Commit the updated `Pulumi.production.yaml` to the **Rotate** PR (do not run `pulumi up` locally;
   **Deploy** merges it on `main`), then revoke each old credential at its provider. `deploy-pulumi`
   authenticates to AWS via OIDC (`AWS_ROLE_ARN` / `AWS_REGION`), decrypts `Pulumi.production.yaml`
   with KMS, and updates GitHub Actions secrets (`GH_TOKEN`, `GH_PACKAGE_MANAGEMENT_TOKEN`,
   `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_DEFAULT_ACCOUNT_ID`, `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`)
   automatically during the deploy.

   - **The OVH application:** OVH can't rotate one, so make a new one. In the API console, read the
     old consumer key's `rules` (`GET /me/api/credential?applicationId=<id>`, then
     `GET /me/api/credential/{credentialId}`). Create the new application and its consumer key
     together at [createToken](https://api.us.ovhcloud.com/createToken/), signed in, with the same
     or narrower **Rights** and the longest **Validity**. Set `OvhApplicationSecret` and
     `OvhConsumerKey` in `Pulumi.production.yaml`, update `applicationKey` in `infra/providers.ts`
     in the **Rotate** PR (every deploy fails until it merges, because the OVH provider checks that
     key against the new secrets), and delete the old application
     (`DELETE /me/api/application/{applicationId}`), which revokes all its credentials.
   - **Made by Pulumi:** **Remove access** deleted `argo-cmp`'s key and the two Tailscale clients;
     `deploy-pulumi` runs `pulumi up --yes --refresh --stack production`, which refreshes them out
     and creates replacements copied into `KubernetesArgocd*`, `KubernetesTailscaleOauthClient*`,
     and `TS_OAUTH_*`.
   - **Notion:** regenerate the integration's secret in its settings and set it as `NotionApiKey`.
     For `NotionWebhookVerificationToken`, recreate the webhook subscription; the Lambda writes
     Notion's new token to SSM `/tmp/notion-verification-token`. Anyone can post one there, so set
     it only once Notion's Verify accepts it.
   - **Not covered yet:** these need a procedure that these steps don't have, so leave them out of
     the pass above.
     - `HetznerOriginTlsKey` and its Cloudflare origin certificate.
     - The `MainMain*Password`s and `KubernetesGrafanaAdminPassword`. Setting one changes only the
       stored config value: Postgres's `cluster-init.sh` skips roles that exist, and Valkey,
       ClickHouse, and Grafana keep the password they started with, so each needs it changed in the
       service.
     - `HetznerK3sToken`: nodes keep accepting the old token until `k3s token rotate`, and
       production's `ignoreChanges: ['userData']` keeps a deploy from passing the new one.
     - The K3s servers' copy of the `CloudflareBackup*Key`s: `cloud-config.yaml` passes them as
       `--etcd-s3-*` flags once, so etcd snapshots fail once the old key is revoked, until each
       server's flags change and K3s restarts.
     - Secrets the cluster made, which the backup keys could read in the unencrypted etcd snapshots,
       such as cert-manager's `internal-root-ca-secret` (10 years, `rotationPolicy: Never`).

5. **Deploy.** Merge **Rotate**'s PR, which runs `deploy-pulumi`, then run
   `gh workflow run deploy-infra.yaml -f deploy=pulumi` once more if any copied output
   (`KubernetesArgocd*`, `TS_OAUTH_*`) needs a second pass after refresh. Wait for each run to
   succeed (`gh run watch <id> --exit-status`). Then, if production has cluster nodes
   (`infra/vps/vps.ts`), do these; if `prod-cluster` is missing from `tailscale status`, stop and
   restore access or rebuild the cluster first:
   1. Switch to it with `tailscale configure kubeconfig prod-cluster`.
   2. Before any new value reaches it, check that the `prod-cluster` Application's `spec.source` is
      `main`'s `k3s/overlays/prod` and it has no `spec.sources`, and delete workloads you didn't
      deploy and anything Argo marks as requiring pruning: `prune: false` keeps what a patched
      source or a reverted commit added. If you found either, its pods could write to the nodes, so
      stop and rebuild the cluster first.
   3. Run `pnpm cluster deploy prod`. It reads outputs from the last deploy's state, so running it
      earlier would re-apply old values, including the revoked PAT in `ghcr-auth` (`argocd`
      namespace). Argo can't fix `ghcr-auth` itself because it fetches `main` with that PAT.
   4. Restart what reads rotated Secrets as env vars only at start, starting with
      `kubectl -n argocd rollout restart deployment argocd-repo-server`, whose renderer holds the
      AWS key, and the Postgres pods, whose pgBackRest holds the backup keys. Also restart every
      workload running an image **Remove access** republished, and check each new pod's `imageID` is
      the trusted digest.

   Run these yourself: they're the intended recovery paths that AGENTS.md hazard 1 keeps agents from
   running.

6. **After the deploy.** Fix what needed the new values:
   - **Servers isolated in Remove access:** Pulumi can't re-create `OvhDevVps`, which is imported
     with `protect`, `retainOnDelete`, and `ignoreChanges` on plan fields. Rebuild or reinstall its
     OS in OVH and re-provision it by hand, or order a new VPS and change its `import` in
     `infra/dev.ts` by PR. While production has Hetzner nodes, re-create them from Pulumi;
     production's `protect` and `ignoreChanges: ['userData']` keep a plain deploy from replacing
     one.
   - **Tailscale:** remove Pulumi's old OAuth clients if any are left, and the auth keys and child
     credentials they made, as in **Remove access**.

7. **Audit.** The Cloudflare, Hetzner, OVH, and Twilio credentials stayed live until **Rotate**.
   Repeat **Remove access** for anything created or changed since it began. A server action you
   didn't run means that node may have read **Deploy**'s new values, so isolate it and repeat
   **Rotate** and **Deploy**. Then:
   - **Cloudflare:** review every write in the Audit Logs since the leak: DNS records, Workers, zone
     rules and Snippets, Email Routing, Pages domains and settings, and R2 bucket access. Pulumi
     resets none it doesn't manage, so undo them.
   - **Backups:** the backup keys can read, overwrite, and delete the backup bucket. Treat its
     contents as read, check for objects deleted or replaced since the leak, and restore the latest
     Postgres and ClickHouse backups somewhere disposable before relying on them.
   - **Twilio:** review Monitor Events since the leak
     ([analyze](https://www.twilio.com/docs/usage/fraud-response-guide/analyze)) and undo changes
     you didn't make, such as geo permissions, phone numbers, and messaging services.
   - **Usage:** review Twilio's message and call logs, and Oxylabs' and every provider's usage and
     billing, since the leak for traffic you didn't send. Treat the pages shared with the Notion
     integration, the `KwokPhoneNumber` and `MichellePhoneNumber` secrets, and Twilio's retained
     messages and media as read.
