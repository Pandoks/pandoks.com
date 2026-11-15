import { isProduction } from './dns';
import { githubRepositoryName } from './github';
import { secrets } from './secrets';

// NOTE: the webhook and local `sst shell` syncs read the blog database ID from here
export const notion = new sst.Linkable('Notion', {
  properties: { blogDatabaseId: '20f1bb259e4b804ba24be1ceebf4c761' }
});

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
    value: secrets.notion.ApiKey.value
  });
  new github.ActionsEnvironmentVariable('GithubNotionBlogDatabaseId', {
    repository: githubRepositoryName,
    environment: githubNotionEnvironment.environment,
    variableName: 'BLOG_NOTION_DATABASE_ID',
    value: notion.properties.blogDatabaseId
  });
}
