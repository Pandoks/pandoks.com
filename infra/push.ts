import { isProduction } from './dns';
import { githubOrg, githubRepoName } from './github';
import { secrets, setSecret } from './secrets';

export const outputs: Record<string, unknown> = {};

if (isProduction) {
  const deadLetterQueue = new aws.sqs.Queue('PushDeadLetterQueue', {
    name: `push-dlq-${$app.stage}`,
    messageRetentionSeconds: 1_209_600,
    sqsManagedSseEnabled: true
  });

  const queue = new aws.sqs.Queue('PushQueue', {
    name: `push-${$app.stage}`,
    messageRetentionSeconds: 345_600,
    receiveWaitTimeSeconds: 20,
    redrivePolicy: $jsonStringify({
      deadLetterTargetArn: deadLetterQueue.arn,
      maxReceiveCount: 5
    }),
    sqsManagedSseEnabled: true,
    visibilityTimeoutSeconds: 60
  });

  const workerUser = new aws.iam.User('PushWorkerUser', {
    name: `push-worker-${$app.stage}`
  });

  new aws.iam.UserPolicy('PushWorkerPolicy', {
    user: workerUser.name,
    policy: $jsonStringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: [
            'sqs:ChangeMessageVisibility',
            'sqs:DeleteMessage',
            'sqs:GetQueueAttributes',
            'sqs:GetQueueUrl',
            'sqs:ReceiveMessage'
          ],
          Resource: queue.arn
        }
      ]
    })
  });

  const workerAccessKey = new aws.iam.AccessKey('PushWorkerAccessKey', {
    user: workerUser.name
  });

  const googleProjectId = `pandoks-mobile-${$app.stage}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 30)
    .replace(/-$/, '');

  const googleProject = new gcp.organizations.Project('PushGoogleProject', {
    name: `Pandoks mobile ${$app.stage}`,
    projectId: googleProjectId,
    deletionPolicy: $app.stage === 'production' ? 'PREVENT' : 'DELETE',
    labels: {
      firebase: 'enabled'
    }
  });

  const serviceUsageApi = new gcp.projects.Service('PushServiceUsageApi', {
    project: googleProject.projectId,
    service: 'serviceusage.googleapis.com',
    disableOnDestroy: false
  });

  const googleApis = [
    'cloudresourcemanager.googleapis.com',
    'fcm.googleapis.com',
    'firebase.googleapis.com',
    'firebaseinstallations.googleapis.com',
    'iam.googleapis.com',
    'iamcredentials.googleapis.com',
    'sts.googleapis.com'
  ].map(
    (service) =>
      new gcp.projects.Service(
        `Push${service
          .split('.')[0]
          .split('-')
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join('')}Api`,
        {
          project: googleProject.projectId,
          service,
          disableOnDestroy: false
        },
        { dependsOn: serviceUsageApi }
      )
  );

  const firebaseProject = new gcp.firebase.Project(
    'PushFirebaseProject',
    {
      project: googleProject.projectId
    },
    { dependsOn: googleApis }
  );

  const androidApp = new gcp.firebase.AndroidApp(
    'PushFirebaseAndroidApp',
    {
      project: googleProject.projectId,
      displayName: 'mobile-template',
      packageName: 'com.pandoks.mobiletemplate',
      deletionPolicy: $app.stage === 'production' ? 'PREVENT' : 'DELETE'
    },
    { dependsOn: firebaseProject }
  );

  const sender = new gcp.serviceaccount.Account(
    'PushFirebaseSender',
    {
      project: googleProject.projectId,
      accountId: 'push-worker',
      displayName: 'Push worker'
    },
    { dependsOn: googleApis }
  );

  const senderRole = new gcp.projects.IAMMember('PushFirebaseSenderRole', {
    project: googleProject.projectId,
    role: 'roles/firebasecloudmessaging.admin',
    member: sender.member
  });

  const senderKey = new gcp.serviceaccount.Key(
    'PushFirebaseSenderKey',
    {
      serviceAccountId: sender.name
    },
    { dependsOn: senderRole }
  );

  const androidAppConfig = gcp.firebase.getAndroidAppConfigOutput({
    project: googleProject.projectId,
    appId: androidApp.appId
  });

  const githubDeployer = new gcp.serviceaccount.Account(
    'PushFirebaseGithubDeployer',
    {
      project: googleProject.projectId,
      accountId: 'infra-deployer',
      displayName: 'GitHub infrastructure deployer'
    },
    { dependsOn: googleApis }
  );

  const githubDeployerRoles = [
    'roles/firebase.admin',
    'roles/iam.serviceAccountAdmin',
    'roles/iam.serviceAccountKeyAdmin',
    'roles/iam.workloadIdentityPoolAdmin',
    'roles/resourcemanager.projectIamAdmin',
    'roles/serviceusage.serviceUsageAdmin'
  ].map(
    (role, index) =>
      new gcp.projects.IAMMember(`PushFirebaseGithubDeployerRole${index}`, {
        project: googleProject.projectId,
        role,
        member: githubDeployer.member
      })
  );

  const githubPool = new gcp.iam.WorkloadIdentityPool(
    'PushFirebaseGithubPool',
    {
      project: googleProject.projectId,
      workloadIdentityPoolId: 'github',
      displayName: 'GitHub Actions',
      deletionPolicy: 'PREVENT'
    },
    { dependsOn: googleApis }
  );

  const githubProvider = new gcp.iam.WorkloadIdentityPoolProvider(
    'PushFirebaseGithubProvider',
    {
      project: googleProject.projectId,
      workloadIdentityPoolId: githubPool.workloadIdentityPoolId,
      workloadIdentityPoolProviderId: 'pandoks-com',
      displayName: 'Pandoks website',
      attributeMapping: {
        'google.subject': 'assertion.sub',
        'attribute.repository': 'assertion.repository'
      },
      attributeCondition: `assertion.repository == '${githubOrg}/${githubRepoName}'`,
      oidc: {
        issuerUri: 'https://token.actions.githubusercontent.com'
      },
      deletionPolicy: 'PREVENT'
    },
    { dependsOn: googleApis }
  );

  new gcp.serviceaccount.IAMMember(
    'PushFirebaseGithubIdentity',
    {
      serviceAccountId: githubDeployer.name,
      role: 'roles/iam.workloadIdentityUser',
      member: $interpolate`principalSet://iam.googleapis.com/${githubPool.name}/attribute.repository/${githubOrg}/${githubRepoName}`
    },
    { dependsOn: githubDeployerRoles }
  );

  new github.ActionsVariable('GithubGoogleProject', {
    repository: githubRepoName,
    variableName: 'GCP_PROJECT_ID',
    value: googleProject.projectId
  });

  new github.ActionsVariable('GithubGoogleServiceAccount', {
    repository: githubRepoName,
    variableName: 'GCP_SERVICE_ACCOUNT',
    value: githubDeployer.email
  });

  new github.ActionsVariable('GithubGoogleWorkloadIdentityProvider', {
    repository: githubRepoName,
    variableName: 'GCP_WORKLOAD_IDENTITY_PROVIDER',
    value: githubProvider.name
  });

  $resolve([
    secrets.push.QueueUrl.name,
    secrets.push.QueueUrl.value,
    queue.url,
    secrets.push.AwsAccessKeyId.name,
    secrets.push.AwsAccessKeyId.value,
    workerAccessKey.id,
    secrets.push.AwsSecretAccessKey.name,
    secrets.push.AwsSecretAccessKey.value,
    workerAccessKey.secret
  ]).apply(
    ([
      queueUrlName,
      queueUrlValue,
      nextQueueUrl,
      accessKeyIdName,
      accessKeyIdValue,
      nextAccessKeyId,
      secretAccessKeyName,
      secretAccessKeyValue,
      nextSecretAccessKey
    ]) => {
      if (queueUrlValue !== nextQueueUrl) {
        setSecret(queueUrlName, nextQueueUrl);
      }
      if (accessKeyIdValue !== nextAccessKeyId) {
        setSecret(accessKeyIdName, nextAccessKeyId);
      }
      if (secretAccessKeyValue !== nextSecretAccessKey) {
        setSecret(secretAccessKeyName, nextSecretAccessKey);
      }
    }
  );

  $resolve([
    secrets.push.FirebaseProjectId.name,
    secrets.push.FirebaseProjectId.value,
    googleProject.projectId,
    secrets.push.FirebaseServiceAccountJson.name,
    secrets.push.FirebaseServiceAccountJson.value,
    senderKey.privateKey,
    secrets.push.FirebaseGoogleServicesJson.name,
    secrets.push.FirebaseGoogleServicesJson.value,
    androidAppConfig.configFileContents
  ]).apply(
    ([
      projectIdName,
      projectIdValue,
      nextProjectId,
      serviceAccountName,
      serviceAccountValue,
      encodedServiceAccount,
      googleServicesName,
      googleServicesValue,
      encodedGoogleServices
    ]) => {
      const nextServiceAccount = Buffer.from(encodedServiceAccount, 'base64').toString('utf8');
      const nextGoogleServices = Buffer.from(encodedGoogleServices, 'base64').toString('utf8');
      if (projectIdValue !== nextProjectId) {
        setSecret(projectIdName, nextProjectId);
      }
      if (serviceAccountValue !== nextServiceAccount) {
        setSecret(serviceAccountName, nextServiceAccount);
      }
      if (googleServicesValue !== nextGoogleServices) {
        setSecret(googleServicesName, nextGoogleServices);
      }
    }
  );

  Object.assign(outputs, {
    pushQueueUrl: queue.url,
    pushDeadLetterQueueUrl: deadLetterQueue.url,
    firebaseProjectId: googleProject.projectId,
    firebaseAndroidAppId: androidApp.appId
  });
}
