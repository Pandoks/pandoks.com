# OVH VPS-4 development host

After the SST state cleanup in this runbook, SST does not purchase or manage
this VPS. Purchase or reinstall VPS-4 with Ubuntu 24.04 in the OVH Control
Panel.

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

## Prepare over Tailscale

From another terminal, prove that the private path works:

```sh
tailscale ssh root@pandoks-dev-box
```

Clone this repository using your normal GitHub authentication, then run:

```sh
cd pandoks.com
sudo scripts/dev-vps/setup.sh prepare
exit
tailscale ssh pandoks@pandoks-dev-box
cd pandoks.com
sudo scripts/dev-vps/setup.sh verify-tailscale
sudo scripts/dev-vps/setup.sh lockdown
sudo scripts/dev-vps/setup.sh status
pnpm bootstrap all
```

Do not close the original OVH console until the second
`tailscale ssh pandoks@pandoks-dev-box` succeeds after lockdown.

## Verify the public interface

From a machine outside the tailnet:

```sh
printf "VPS public IP from OVH Control Panel: "
read -r VPS_PUBLIC_IP
nc -vz -w 5 "${VPS_PUBLIC_IP}" 22
```

The connection must fail. Never save the entered address as an application
secret.

## SST state cleanup

Export state before changing it:

```sh
./node_modules/.bin/sst state export --stage pandoks \
  > /tmp/pandoks-state-before-dev-vps-cleanup.json
jq -r '
  .deployment.resources[]
  | select(.urn | contains("OvhDevBox"))
  | [.urn, .type, (.protect // false)]
  | @tsv
' /tmp/pandoks-state-before-dev-vps-cleanup.json
```

This output intentionally does not print any registration-key value. Do not
print, copy, or put a registration-key value in shell history.

If there are no rows, no state cleanup is needed.

If an `OvhDevBox` row is present, run this identity gate before either
detach/delete branch. Enter the expected OVH service ID from the Control Panel;
the command compares it only to the exact `OvhDevBox` resource ID, prints no ID
value, and removes the entered value from the shell after the comparison:

```sh
printf "Expected OVH service ID from OVH Control Panel: "
read -r EXPECTED_OVH_SERVICE_ID
if jq -e --arg expected "${EXPECTED_OVH_SERVICE_ID}" '
  any(
    .deployment.resources[];
    (.urn | endswith("::OvhDevBox")) and (.id == $expected)
  )
' /tmp/pandoks-state-before-dev-vps-cleanup.json >/dev/null; then
  printf '%s\n' "OvhDevBox service ID matches exported state."
else
  printf '%s\n' "OvhDevBox service ID does not match exported state; do not continue."
  unset EXPECTED_OVH_SERVICE_ID
  exit 1
fi
unset EXPECTED_OVH_SERVICE_ID
```

If the gate does not report a match, do not run either detach/delete branch.

Check separately for the registration-key resource by logical name only; this
does not inspect or print a key value:

```sh
if jq -e '
  any(
    .deployment.resources[];
    .urn | endswith("::OvhDevBoxTailnetRegistrationAuthKey")
  )
' /tmp/pandoks-state-before-dev-vps-cleanup.json >/dev/null; then
  printf '%s\n' "OvhDevBoxTailnetRegistrationAuthKey state record is present."
else
  printf '%s\n' "OvhDevBoxTailnetRegistrationAuthKey state record is absent."
fi
```

Only after the identity gate reports a match and the keep/delete decision is
confirmed, if the `OvhDevBox` row identifies the VPS-4 that you are retaining
manually, detach its state record without deleting the physical service:

```sh
./node_modules/.bin/sst state remove OvhDevBox --stage pandoks
```

Only if the separate presence check reports that its related
`OvhDevBoxTailnetRegistrationAuthKey` row is present, confirm that it belongs
to this old dev-box configuration, then detach that state record as well. Do
not print or copy the key value:

```sh
./node_modules/.bin/sst state remove OvhDevBoxTailnetRegistrationAuthKey --stage pandoks
```

Only after the identity gate reports a match, if the `OvhDevBox` row identifies
an obsolete Public Cloud instance or failed VPS order, confirm its service ID
in the OVH Control Panel, delete that exact provider resource there, and only
then remove its stale state reference:

```sh
./node_modules/.bin/sst state remove OvhDevBox --stage pandoks
```

Only if the separate presence check reports that a related
`OvhDevBoxTailnetRegistrationAuthKey` row is present, confirm it belongs to the
obsolete configuration, then remove that stale state reference without printing
or copying its key value:

```sh
./node_modules/.bin/sst state remove OvhDevBoxTailnetRegistrationAuthKey --stage pandoks
```

Never run either `sst state remove` command until the identity gate reports a
match and the keep/delete decision is confirmed.

Finally:

```sh
./node_modules/.bin/sst diff --stage pandoks
```

The diff must contain no creation, replacement, or deletion for either
`OvhDevBox` or `OvhDevBoxTailnetRegistrationAuthKey`.

## Recovery

If Tailscale fails before lockdown, continue in the still-open OVH console.

If access fails after lockdown, use the OVH KVM console or rescue environment:

```sh
nft flush ruleset
systemctl restart tailscaled
tailscale status
```

Repair Tailscale, prove `tailscale ssh pandoks@pandoks-dev-box`, then rerun:

```sh
cd pandoks.com
sudo scripts/dev-vps/setup.sh verify-tailscale
sudo scripts/dev-vps/setup.sh lockdown
```
