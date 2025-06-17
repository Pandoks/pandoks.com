import { secrets } from './secrets';

export const githubRepo = github.getRepository({
  fullName: 'pandoks/pandoks.com'
});

if ($app.stage === 'production') {
  new github.ActionsSecret('GithubCloudflareApiToken', {
    repository: githubRepo.then((r) => r.name),
    secretName: 'CLOUDFLARE_API_TOKEN',
    plaintextValue: secrets.cloudflare.ApiKey.value
  });

  new github.ActionsSecret('GithubCloudflareAccountId', {
    repository: githubRepo.then((r) => r.name),
    secretName: 'CLOUDFLARE_DEFAULT_ACCOUNT_ID',
    plaintextValue: secrets.cloudflare.AccountId.value
  });
}
