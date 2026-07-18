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
  | select(
      (.urn | endswith("::OvhDevBox"))
      or (.urn | endswith("::OvhDevBoxTailnetRegistrationAuthKey"))
    )
  | [.urn, .type, (.protect // false)]
  | @tsv
' /tmp/pandoks-state-before-dev-vps-cleanup.json
```

This output intentionally does not print any registration-key value. Do not
print, copy, or put a registration-key value in shell history.

First check the exact logical-name presence of the primary and registration-key
records. This decision tree prints no resource ID or registration-key value.
It fails closed if either logical name is ambiguous:

```sh
OVH_DEV_BOX_COUNT="$(jq '
  [.deployment.resources[] | select(.urn | endswith("::OvhDevBox"))] | length
' /tmp/pandoks-state-before-dev-vps-cleanup.json)"
OVH_DEV_BOX_KEY_COUNT="$(jq '
  [.deployment.resources[]
   | select(.urn | endswith("::OvhDevBoxTailnetRegistrationAuthKey"))]
  | length
' /tmp/pandoks-state-before-dev-vps-cleanup.json)"

case "${OVH_DEV_BOX_COUNT}:${OVH_DEV_BOX_KEY_COUNT}" in
  "0:0")
    printf '%s\n' "Neither OvhDevBox state record is present; no cleanup is needed. Continue to the final diff."
    unset OVH_DEV_BOX_COUNT OVH_DEV_BOX_KEY_COUNT
    ;;
  "0:1")
    printf '%s\n' "Only the OvhDevBox registration-key state record is present; removing the orphaned record."
    if ./node_modules/.bin/sst state remove OvhDevBoxTailnetRegistrationAuthKey --stage pandoks; then
      printf '%s\n' "The orphaned registration-key state record was removed. Continue directly to the final diff."
    else
      printf '%s\n' "The orphaned registration-key state record could not be removed; do not continue."
      unset OVH_DEV_BOX_COUNT OVH_DEV_BOX_KEY_COUNT
      exit 1
    fi
    unset OVH_DEV_BOX_COUNT OVH_DEV_BOX_KEY_COUNT
    ;;
  "1:0" | "1:1")
    ;;
  *)
    printf '%s\n' "OvhDevBox state records are ambiguous; do not continue."
    unset OVH_DEV_BOX_COUNT OVH_DEV_BOX_KEY_COUNT
    exit 1
    ;;
esac
```

If the primary record was absent (`0:0` or `0:1`), do not run either primary
detach/delete branch below; continue directly to the final diff after the
orphaned-key removal, if any. If the primary record was present (`1:0` or
`1:1`), run this type-aware identity gate before either detach/delete branch.
It uses the exported Pulumi resource's `type`, `id`, and, for a Public Cloud
instance, `inputs.serviceName`. It prints no ID or service value and removes
entered values from the shell after comparison:

For a historical `ovh.cloudproject.Instance` (`ovh:CloudProject/instance:Instance`
in exported state), obtain both the Public Cloud instance ID/UUID and the
separate Public Cloud project/service ID from the OVH Control Panel. For an
`ovh.vps.Vps` order (`ovh:Vps/vps:Vps` in exported state), obtain the VPS
service name/ID that identifies that VPS. Any other type or any mismatch stops
the procedure.

```sh
OVH_DEV_BOX_TYPE="$(jq -r '
  [.deployment.resources[] | select(.urn | endswith("::OvhDevBox"))]
  | if length == 1 then .[0].type else empty end
' /tmp/pandoks-state-before-dev-vps-cleanup.json)"

case "${OVH_DEV_BOX_TYPE}" in
  "ovh:CloudProject/instance:Instance")
    printf "Expected OVH Public Cloud instance ID/UUID from Control Panel: "
    read -r EXPECTED_INSTANCE_ID
    printf "Expected OVH Public Cloud project/service ID from Control Panel: "
    read -r EXPECTED_PROJECT_SERVICE_ID
    if jq -e \
      --arg instance "${EXPECTED_INSTANCE_ID}" \
      --arg project "${EXPECTED_PROJECT_SERVICE_ID}" '
        any(
          .deployment.resources[];
          (.urn | endswith("::OvhDevBox"))
          and (.type == "ovh:CloudProject/instance:Instance")
          and (.id == $instance)
          and (.inputs.serviceName == $project)
        )
      ' /tmp/pandoks-state-before-dev-vps-cleanup.json >/dev/null; then
      printf '%s\n' "OvhDevBox instance and project/service IDs match exported state."
    else
      printf '%s\n' "OvhDevBox instance or project/service ID does not match exported state; do not continue."
      unset EXPECTED_INSTANCE_ID EXPECTED_PROJECT_SERVICE_ID OVH_DEV_BOX_TYPE
      exit 1
    fi
    unset EXPECTED_INSTANCE_ID EXPECTED_PROJECT_SERVICE_ID
    ;;
  "ovh:Vps/vps:Vps")
    printf "Expected OVH VPS service name/ID from Control Panel: "
    read -r EXPECTED_VPS_SERVICE_ID
    if jq -e --arg expected "${EXPECTED_VPS_SERVICE_ID}" '
      any(
        .deployment.resources[];
        (.urn | endswith("::OvhDevBox"))
        and (.type == "ovh:Vps/vps:Vps")
        and (.id == $expected)
      )
    ' /tmp/pandoks-state-before-dev-vps-cleanup.json >/dev/null; then
      printf '%s\n' "OvhDevBox VPS service name/ID matches exported state."
    else
      printf '%s\n' "OvhDevBox VPS service name/ID does not match exported state; do not continue."
      unset EXPECTED_VPS_SERVICE_ID OVH_DEV_BOX_TYPE
      exit 1
    fi
    unset EXPECTED_VPS_SERVICE_ID
    ;;
  *)
    printf '%s\n' "OvhDevBox resource type is unsupported or ambiguous; do not continue."
    unset OVH_DEV_BOX_TYPE
    exit 1
    ;;
esac
unset OVH_DEV_BOX_TYPE
```

If the gate does not report a match, do not run either detach/delete branch.

Only after the identity gate reports a match and the keep/delete decision is
confirmed, if the `OvhDevBox` row identifies the VPS-4 that you are retaining
manually, detach its state record without deleting the physical service:

```sh
./node_modules/.bin/sst state remove OvhDevBox --stage pandoks
```

Only if the initial exact presence check was `1:1`, confirm that its related
`OvhDevBoxTailnetRegistrationAuthKey` row belongs to this old dev-box
configuration, then detach that state record as well. Do not print or copy the
key value:

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

Only if the initial exact presence check was `1:1`, confirm that a related
`OvhDevBoxTailnetRegistrationAuthKey` row belongs to the obsolete configuration,
then remove that stale state reference without printing or copying its key
value:

```sh
./node_modules/.bin/sst state remove OvhDevBoxTailnetRegistrationAuthKey --stage pandoks
```

Never run `sst state remove OvhDevBox` until the identity gate reports a match
and the keep/delete decision is confirmed. Remove the registration-key record
only in the confirmed `1:1` primary-resource branch, or in the exact `0:1`
orphaned-key branch above.

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
