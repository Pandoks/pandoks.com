# OVH VPS-4 development host

SST provisions and lifecycle-manages the VPS-4 subscription declared in
`infra/dev.ts` for the `pandoks` stage. The code orders the VPS-4 plan using
12-month upfront pricing in `US-WEST-OR` with Ubuntu 26.04, standard daily
backup, local system storage, and no provider SSH key. It does not order
Premium backup, snapshots, or additional storage. The Pulumi resource is
protected against accidental replacement or deletion.

Guest OS configuration is intentionally outside IaC. There is no cloud-init,
user-data, or repository-owned guest setup helper. The operator manually owns
account creation, Tailscale enrollment, SSH and firewall hardening, package
installation, and recovery through the OVH console.

Because the non-production cluster currently has zero nodes, this VPS order
does not require an OVH Public Cloud project or k3s token. The OVH application
secret and consumer key are still required to authorize the VPS order.

## Provision the subscription

Review the billable order, then apply it:

```sh
pnpm sst diff --stage pandoks
pnpm sst deploy --stage pandoks
```

Do not approve the deployment unless the diff contains exactly one
`OvhDevVps` using the intended VPS-4 plan and location. Changing the plan,
location, or OS can replace or reinstall a manually configured host; review
those changes through an authenticated diff first.

## Initial console setup

Open the OVH KVM/web console. Do not enable or use public SSH.

```sh
apt-get update
apt-get install -y curl
install_script="$(mktemp)"
curl -fsSL https://tailscale.com/install.sh -o "${install_script}"
sh "${install_script}"
rm -f "${install_script}"
tailscale up \
  --ssh \
  --hostname=pandoks-dev-box \
  --accept-dns=false \
  --advertise-tags=tag:ovh,tag:dev
```

Open the printed Tailscale login URL and approve the device. Keep the OVH
console open.

## Finish guest setup manually

From another terminal, prove that the private path works:

```sh
tailscale ssh root@pandoks-dev-box
```

Complete the one-time host setup through the OVH console and Tailscale. The
required end state is:

- a `pandoks` administrator account with sudo access;
- working Tailscale SSH as `pandoks`;
- disabled password authentication and root SSH;
- a persistent default-deny inbound firewall that permits SSH only through
  `tailscale0` and permits direct Tailscale UDP traffic on port `41641`;
- the repository cloned using the operator's normal GitHub authentication and
  its tool bootstrap completed.

Do not close the original OVH console until the second
`tailscale ssh pandoks@pandoks-dev-box` succeeds after lockdown.

Verify the final state manually:

```sh
tailscale ssh pandoks@pandoks-dev-box
tailscale status
sudo nft list ruleset
sudo sshd -T | grep -E '^(passwordauthentication|permitrootlogin|allowusers) '
```

## Verify the public interface

From a machine outside the tailnet:

```sh
printf "VPS public IP from OVH Control Panel: "
read -r VPS_PUBLIC_IP
nc -vz -w 5 "${VPS_PUBLIC_IP}" 22
```

The connection must fail. Never save the entered address as an application
secret.

## Recovery

If Tailscale fails before lockdown, continue in the still-open OVH console.

If access fails after lockdown, use the OVH KVM console or rescue environment:

```sh
nft flush ruleset
systemctl restart tailscaled
tailscale status
```

Repair Tailscale, prove `tailscale ssh pandoks@pandoks-dev-box`, then manually
reapply and verify the intended SSH and firewall configuration.
