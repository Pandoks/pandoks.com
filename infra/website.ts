import * as pulumi from '@pulumi/pulumi';
import * as cloudflare from '@pulumi/cloudflare';
import { isProduction } from '@pandoks.com/infra/stack';
import { cloudflareAccountId, cloudflareZoneId, domain } from './dns.ts';
import { githubOrg, githubRepositoryName } from './github.ts';

const NODE_VERSION = '24.22.2';

if (isProduction) {
  const pandoksStaticWebsite = new cloudflare.PagesProject('PandoksWebsite', {
    accountId: cloudflareAccountId,
    name: 'pandoks',
    productionBranch: 'main',
    source: {
      type: 'github',
      config: {
        owner: githubOrg,
        repoName: githubRepositoryName,
        productionBranch: 'main',
        prCommentsEnabled: true,
        pathIncludes: [
          'apps/web/*',
          'package.json',
          'packages/svelte/*',
          'pnpm-lock.yaml',
          'pnpm-workspace.yaml',
          'pyproject.toml' // NOTE: Pages runs `pip install .` when present
        ]
      }
    },
    buildConfig: {
      buildCommand: 'pnpm --filter web build',
      destinationDir: 'apps/web/build',
      rootDir: '',
      buildCaching: true
    },
    deploymentConfigs: {
      preview: {
        envVars: {
          NODE_VERSION: { type: 'plain_text', value: NODE_VERSION }
        }
      },
      production: {
        envVars: {
          NODE_VERSION: { type: 'plain_text', value: NODE_VERSION }
        }
      }
    }
  });
  new cloudflare.PagesDomain('PandoksWebsiteDomain', {
    accountId: cloudflareAccountId,
    projectName: pandoksStaticWebsite.name,
    name: domain
  });

  new cloudflare.DnsRecord('PandoksWebsiteDnsRecord', {
    zoneId: cloudflareZoneId,
    name: domain,
    type: 'CNAME',
    content: pulumi.interpolate`${pandoksStaticWebsite.name}.pages.dev`,
    proxied: true,
    ttl: 1
  });

  const pagesDotDevRedirects = new cloudflare.List('PagesDotDevRedirectList', {
    accountId: cloudflareAccountId,
    kind: 'redirect',
    name: 'pages_dot_dev_redirects',
    items: [
      {
        redirect: {
          sourceUrl: 'pandoks.pages.dev/',
          targetUrl: 'https://pandoks.com',
          statusCode: 301,
          includeSubdomains: false,
          subpathMatching: true,
          preserveQueryString: true
        }
      }
    ]
  });

  new cloudflare.Ruleset('PagesDotDevRedirectRuleset', {
    accountId: cloudflareAccountId,
    kind: 'root',
    phase: 'http_request_redirect',
    name: 'account_bulk_redirects',
    rules: [
      {
        action: 'redirect',
        actionParameters: {
          fromList: {
            name: pagesDotDevRedirects.name,
            key: 'http.request.full_uri'
          }
        },
        expression: pulumi.interpolate`http.request.full_uri in $${pagesDotDevRedirects.name}`,
        enabled: true
      }
    ]
  });
}
