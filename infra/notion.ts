import * as github from '@pulumi/github';
import { isProduction } from './dns.ts';
import { githubRepositoryName } from './github.ts';
import { secrets } from './secrets.ts';

export const NOTION_BLOG_DATABASE_ID = '20f1bb259e4b804ba24be1ceebf4c761';

if (isProduction) {
  // NOTE: not production's environment, whose OIDC subject AWS trusts with AdministratorAccess
  const githubNotionEnvironment = new github.RepositoryEnvironment('GithubNotionEnvironment', {
    repository: githubRepositoryName,
    environment: 'notion',
    deploymentBranchPolicy: { protectedBranches: false, customBranchPolicies: true }
  });
  new github.RepositoryEnvironmentDeploymentPolicy('GithubNotionDeploymentPolicy', {
    repository: githubRepositoryName,
    environment: githubNotionEnvironment.environment,
    branchPattern: 'main'
  });

  new github.ActionsEnvironmentSecret('GithubNotionApiKey', {
    repository: githubRepositoryName,
    environment: githubNotionEnvironment.environment,
    secretName: 'NOTION_API_KEY',
    value: secrets.notion.ApiKey
  });
  new github.ActionsEnvironmentVariable('GithubNotionBlogDatabaseId', {
    repository: githubRepositoryName,
    environment: githubNotionEnvironment.environment,
    variableName: 'BLOG_NOTION_DATABASE_ID',
    value: NOTION_BLOG_DATABASE_ID
  });
}
