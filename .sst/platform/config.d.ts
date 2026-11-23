import "./src/global.d.ts"
import "../types.generated"
import { AppInput, App, Config } from "./src/config"
import * as _github from "@pulumi/github";
import * as _tailscale from "@pulumi/tailscale";
import * as _hcloud from "@pulumi/hcloud";
import * as _cloudflare from "@pulumi/cloudflare";
import * as _aws from "@pulumi/aws";
import * as _ovh from "@ovhcloud/pulumi-ovh";


declare global {
  // @ts-expect-error
  export import github = _github
  // @ts-expect-error
  export import tailscale = _tailscale
  // @ts-expect-error
  export import hcloud = _hcloud
  // @ts-expect-error
  export import cloudflare = _cloudflare
  // @ts-expect-error
  export import aws = _aws
  // @ts-expect-error
  export import ovh = _ovh
  interface Providers {
    providers?: {
      "github"?:  (_github.ProviderArgs & { package?: string, version: string }) | string;
      "tailscale"?:  (_tailscale.ProviderArgs & { package?: string, version: string }) | string;
      "hcloud"?:  (_hcloud.ProviderArgs & { package?: string, version: string }) | string;
      "cloudflare"?:  (_cloudflare.ProviderArgs & { package?: string, version?: string }) | string;
      "aws"?:  (_aws.ProviderArgs & { package?: string, version?: string }) | string;
      "ovh"?:  (_ovh.ProviderArgs & { package?: string, version: string }) | string;
    }
  }
  export const $config: (
    input: Omit<Config, "app"> & {
      app(input: AppInput): Promise<Omit<App, "providers"> & Providers> | (Omit<App, "providers"> & Providers);
    },
  ) => Config;
}
