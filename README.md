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
    <img src="https://img.shields.io/badge/toolchain-mise-8B5CF6" alt="Managed with mise">
  </p>

  <p>
    <a href="#getting-started">Getting Started</a> ·
    <a href="#local-kubernetes-cluster">Local Kubernetes</a> ·
    <a href="#development">Development</a>
  </p>
</div>

# Getting Started

1. Install these dependencies before setting up the repository:

- [Git](https://git-scm.com/downloads) and [mise](https://mise.jdx.dev/installing-mise.html)
- [Docker](https://docs.docker.com/get-docker/)
- [OpenSSL](https://www.openssl.org/)
- [Tailscale](https://tailscale.com/download), only for cloud (dev/prod) cluster access

2. Setup `.env.<stage>`. Take a look at [.env.example](/.env.example) as a reference.

3. Setup the repository:

```sh
mise install
pnpm install
```

4. Configure AWS SSO session in `~/.aws/config`. `pnpm sso` points to sso session `personal`, but
   you can change it to whatever you want in `package.json`.

> [!NOTE]
> AWS SSO only verifies you for 12 hours, so you'll have to run `pnpm sso` again once in a while

## Local Kubernetes Cluster

Although not all of the apps are deployed to Kubernetes, majority of the services are running in a
cluster. To make development easier, we can use a local Kubernetes cluster ([k3d](https://k3d.io/))
to run a copy of the production cluster. This makes it so that majority of the times, we can work
offline or test certain features without having to deploy to a full fledged Kubernetes cluster in
the cloud. _Because we're using k3d, which puts an entire Kubernetes cluster inside of docker
containers, not everything is one to one with the production cluster. ie. networking, registries,
etc_

To setup the local cluster, run this from the root of the monorepo. Replace `your-stage` with your
personal SST stage (for example, `pandoks`):

```sh
# Quick setup (all-in-one)
SST_STAGE=your-stage pnpm local:init

# Or step by step:
pnpm cluster k3d deps up               # Start docker compose dependencies
pnpm cluster k3d up                    # Create k3d cluster
pnpm local:build && pnpm local:push    # Build and push images/charts to the local registry
pnpm cluster deploy local --stage your-stage --bootstrap  # First-time: install helm charts + CRDs
pnpm cluster deploy local --stage your-stage # Apply environment overlay
```

To tear down the cluster:

```sh
pnpm local:destroy
```

See [scripts/cluster/README.md](./scripts/cluster/README.md) for more CLI commands,
[k3s/README.md](./k3s/README.md) for cluster architecture details, and
[packages/e2e/README.md](./packages/e2e/README.md) for e2e suites.

## Development

For things that are not deployed to Kubernetes, they are managed by `sst`. To run the development
server, run this from the root of the monorepo:

```sh
pnpm dev --stage your-stage # assuming that you are still verified via SSO
```

## If a production secret leaks

A leak exposes every production `sst.Secret`, so rotate every credential among them. Do these steps
in order: footholds come out after **Close the source** and before **Rotate**, so the attacker can't
watch or undo the rotation, and only what needs the new values waits for **Deploy**.

1. **Delete the PAT.** Delete the token in `GithubPersonalAccessToken` (GitHub → Settings →
   Developer settings → Personal access tokens) before anything else, and make no new one until
   **Rotate**. Pulumi manages this repo with it and writes it as `GH_TOKEN`, so anyone holding it
   can open the `production` environment to another branch and read its secrets. Renovate, the
   internet-facing `NotionWebhookHandler` Lambda, the cluster's `ghcr-auth` Secrets, and SSM's
   `/runners/prod/github-cloning-pat`, which any runner job can read, hold it too.

2. **Close the source.** Before any new value exists:
   - Review `main`'s merged commits and PRs since the leak. The `main` ruleset requires no
     approvals, so a PAT holder can merge.
   - Remove the leaking dependency or input from `main` by PR and merge it, dispatching nothing
     before then: `deploy-sst` installs it beside every secret. Deploys fail until **Rotate**, since
     the GitHub provider looks up `GH_TOKEN`'s user and gets 401 for the deleted PAT, so
     **Deploy**'s is the first that lands.
   - In a new terminal, which every later step uses, update to the fixed `main` and run
     `pnpm install --frozen-lockfile`. A leftover dependency's `node` bin would otherwise replace
     the `node` that `pnpm sst secret set` starts.

3. **Remove access.** Remove what the attacker can still act through, back to the leak's start:
   - **AWS:** in CloudTrail →
     [Event history](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/view-cloudtrail-events.html)
     (90 days), check `us-east-1` for IAM and every Region in use (`us-west-1`, and `us-west-2` for
     the runners). Undo every write you didn't make: IAM users, keys, roles, identity providers,
     `PersonalGithubActions`' trust policy (the role has `AdministratorAccess`), bucket policies,
     and anything else.
   - **GitHub:** remove collaborators, invitations, deploy keys, and webhooks you didn't add. Check
     `production`'s branch policy: the first command must print
     `{"custom_branch_policies":true,"protected_branches":false}`, and the second only
     `branch main`.

     ```sh
     gh api 'repos/{owner}/{repo}/environments/production' --jq .deployment_branch_policy
     gh api 'repos/{owner}/{repo}/environments/production/deployment-branch-policies' \
       --jq '.branch_policies[] | "\(.type) \(.name)"'
     ```

   - **Servers:** review each server's actions since the leak: Hetzner's `/servers/{id}/actions`
     (`create_image`, `enable_rescue`, `reset_password`, `request_console`, `attach_iso`, `rebuild`)
     and OVH's `/vps/{serviceName}/tasks` (`createSnapshot`, `snapshot/download`,
     `netbootMode: rescue`, `rebuild`). Isolate or power off any server with an action you didn't
     run, and treat its data, and any snapshotted disk's, as read. Delete snapshots and SSH keys
     (Hetzner's `/ssh_keys`, OVH's `/me/sshKey`) you didn't make. Production has no Hetzner nodes;
     its one server is the imported OVH `OvhDevVps`, `vps-54c42746.vps.ovh.us`.
   - **OVH account:** the leaked consumer key can create access that outlives **Rotate**. In the
     signed-in [API console](https://api.us.ovhcloud.com/console), delete each of these you didn't
     make by its `DELETE` route: OAuth2 clients (`/me/api/oauth2/client/{clientId}`, beta), IAM
     users and their tokens (`/me/identity/user/{user}` and `…/token/{name}`), the SAML identity
     provider (`/me/identity/provider`), IAM policies (v2 `/iam/policy/{policyId}`), and
     applications (`/me/api/application/{applicationId}`, listed by `GET /me/api/application`).
   - **Tailscale:** the root OAuth client can make credentials and devices that reach every tailnet
     node. Under
     [Settings → Trust credentials](https://console.tailscale.com/admin/settings/trust-credentials),
     revoke every OAuth client or federated identity you didn't make. That leaves the auth keys and
     child credentials it made, which configuration audit logs list with its client ID as the actor,
     so revoke those under [Settings → Keys](https://console.tailscale.com/admin/settings/keys).
     Revoking a key leaves its devices, so remove the ones you didn't add under
     [Machines](https://console.tailscale.com/admin/machines).
   - **Cloudflare:** delete API tokens you didn't make, found in the account's
     [Audit Logs](https://developers.cloudflare.com/fundamentals/account/account-security/review-audit-logs/)
     (18 months).
   - **Twilio:** `TwilioAuthToken` can make API keys and subaccounts that keep working after
     **Rotate**. Under View Subaccounts, close any subaccount you didn't make, and rotate the Auth
     Token of each you keep
     ([contain](https://www.twilio.com/docs/usage/fraud-response-guide/contain)). In the main
     account and each kept subaccount, open Settings → Account settings → API keys & auth tokens →
     API keys, and delete each key you didn't make: its name → Delete this key → Delete
     ([API keys](https://www.twilio.com/docs/iam/api-keys/keys-in-console)).

4. **Rotate.** Set a new PAT as `GithubPersonalAccessToken`, then rotate every other production
   `sst.Secret` that holds a credential with `pnpm sst secret set <Name> --stage production`, which
   prompts for the value. `deploy-sst` signs in with GitHub secrets that only Pulumi writes, so
   right after setting one of the `sst.Secret`s below, set its GitHub secret with
   `gh secret set <NAME>`, which also prompts. Then revoke the old credential at its provider.

   | `sst.Secret`                 | GitHub secret                       |
   | ---------------------------- | ----------------------------------- |
   | `GithubPersonalAccessToken`  | `GH_TOKEN`                          |
   | `CloudflareApiKey`           | `CLOUDFLARE_API_TOKEN`              |
   | `HetznerApiKey`              | `HCLOUD_TOKEN` (`--env production`) |
   | `OvhApplicationSecret`       | `OVH_APPLICATION_SECRET`            |
   | `OvhConsumerKey`             | `OVH_CONSUMER_KEY`                  |
   | `TailscaleOauthClientId`     | `TAILSCALE_OAUTH_CLIENT_ID`         |
   | `TailscaleOauthClientSecret` | `TAILSCALE_OAUTH_CLIENT_SECRET`     |

   `sst secret set` can't rotate OVH's application, what Pulumi makes, or the copies marked
   "Automatically set during deploy" in `infra/secrets.ts`, since a deploy writes the resource's
   value back over a hand-set copy. Replace these in one PR, which **Deploy** merges. Every deploy
   fails until it merges, since the OVH provider checks `applicationKey` in `sst.config.ts` against
   the new OVH secrets.
   - **The OVH application:** OVH can't rotate one, so make a new one. In the API console, read the
     old consumer key's `rules` (`GET /me/api/credential?applicationId=<id>`, then
     `GET /me/api/credential/{credentialId}`). Create the new application and its consumer key
     together at [createToken](https://api.us.ovhcloud.com/createToken/), signed in, with the same
     or narrower **Rights** and the longest **Validity**. Set `OvhApplicationSecret` and
     `OvhConsumerKey` from it, change `applicationKey` in the PR, and delete the old application
     (`DELETE /me/api/application/{applicationId}`), which revokes all its credentials.
   - **Made by Pulumi:** find an input change that replaces each; none is tested yet.
     - `argo-cmp`'s AWS access key, copied into `KubernetesArgocd*`. It can read production's SST
       state and passphrase.
     - The k8s operator's Tailscale OAuth client, copied into `KubernetesTailscaleOauthClient*`.
     - The GitHub Actions Tailscale client, written as `TS_OAUTH_*`. Its `tag:ci` nodes reach every
       node, and the prod cluster API as `argocd-deployer`, which can patch Argo `Application`s.
     - `HetznerOriginTlsKey` and its Cloudflare origin certificate. A deploy makes a new key and
       CSR, and sets both secrets, only when `infra/vps/vps.origin.prod.csr` is missing, and that
       CSR is committed.

5. **Deploy.** Merge **Rotate**'s PR, which deploys SST, then run
   `gh workflow run deploy-infra.yaml -f deploy=sst` once more: the deploy that replaces a copied
   credential records the old value in state. Only then switch to the cluster with
   `tailscale configure kubeconfig prod-cluster` and run
   `pnpm cluster deploy prod --stage production`. It reads values from the last deploy's state, not
   the secret store, so earlier it would re-apply old values, including the revoked PAT to the
   Secrets in **Delete the PAT**. Argo can't fix those itself: it fetches `main` with that PAT. Run
   both commands yourself: they're the intended recovery paths that AGENTS.md hazard 1 keeps agents
   from running.

6. **After the deploy.** Fix what needed the new values:
   - **Servers isolated in Remove access:** SST can't re-create `OvhDevVps`, which is imported with
     `protect` and `ignoreChanges`. Rebuild or reinstall its OS in OVH and re-provision it by hand,
     or order a new VPS and change its `import` by PR. While production has Hetzner nodes, re-create
     them from SST; production's `protect` and `ignoreChanges: ['userData']` keep a plain deploy
     from replacing one.
   - **Tailscale:** if **Rotate**'s replacements left Pulumi's old OAuth clients, remove them and
     the auth keys and child credentials they made, as in **Remove access**.

7. **Audit.** The root Tailscale client and the Cloudflare, Hetzner, OVH, and Twilio credentials
   stayed live until **Rotate**, and Pulumi's two Tailscale clients until **Deploy**. Repeat
   **Remove access** for anything created since it began: Tailscale trust credentials, keys, and
   devices; Cloudflare API tokens; Hetzner and OVH actions, SSH keys, and snapshots; OVH OAuth2
   clients, IAM users and tokens, identity provider, policies, and applications; Twilio API keys and
   subaccounts; and GitHub. Then check Cloudflare's Audit Logs since the leak for DNS records and
   Workers SST doesn't manage, and delete them.
