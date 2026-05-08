import { cloudflareAccountId, cloudflareZoneId, domain, isProduction } from './dns';
import { githubOrg, githubRepoName } from './github';

new sst.x.DevCommand('DevWebsite', {
  dev: {
    title: 'WebsiteDev',
    command: 'pnpm dev',
    autostart: false,
    directory: 'apps/web'
  }
});

if (isProduction) {
  const personalStaticWebsite = new cloudflare.PagesProject('PersonalWebsite', {
    accountId: cloudflareAccountId,
    name: 'pandoks',
    productionBranch: 'main',
    source: {
      type: 'github',
      config: {
        owner: githubOrg,
        repoName: githubRepoName,
        productionBranch: 'main',
        prCommentsEnabled: true,
        pathIncludes: ['apps/web/**', 'packages/svelte/**', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
      }
    },
    buildConfig: {
      buildCommand: 'pnpm --filter web build',
      destinationDir: 'apps/web/build',
      rootDir: '',
      buildCaching: true
    }
  });
  new cloudflare.PagesDomain('PersonalWebsiteDomain', {
    accountId: cloudflareAccountId,
    projectName: personalStaticWebsite.name,
    name: domain
  });

  new cloudflare.DnsRecord('PersonalWebsiteDnsRecord', {
    zoneId: cloudflareZoneId,
    name: domain,
    type: 'CNAME',
    content: $interpolate`${personalStaticWebsite.name}.pages.dev`,
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
        expression: $interpolate`http.request.full_uri in $${pagesDotDevRedirects.name}`,
        enabled: true
      }
    ]
  });
}
