# Title

## Description

## Checklist

- [ ] _If you have added a new dependency to this project_, make sure to add it to the dependencies part of the README.
- [ ] _If you have interacted with [`SST Secrets`](https://sst.dev/docs/component/secret/)_, make sure to deploy it and that it doesn't just exist in the intermediary state of `sst secret list`. Run `pnpm sst shell -- node ./scripts/lib/sst-resources.ts` to see the deployed resources created by SST.
- [ ] _If you have added a new package image_, make sure to add it to the CI build matrix in [`build-and-publish.yaml`](https://github.com/Pandoks/pandoks.com/blob/main/.github/workflows/build-and-publish.yaml), the pins in [`k3s/components/images`](https://github.com/Pandoks/pandoks.com/blob/main/k3s/components/images/kustomization.yaml), and the local overlay's `images:` overrides.
- [ ] _If you have created a new kubernetes node and control plane_, make sure to add the endpoint to the [`prom-grafana.yaml`](https://github.com/Pandoks/pandoks.com/blob/main/k3s/overlays/cluster/prom-etcd-config.yaml) overlays.
- [ ] _If you create a new app deployment_, make sure to add Prometheus metrics to export for observability.
