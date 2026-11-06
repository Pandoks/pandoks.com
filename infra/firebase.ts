import { isProduction } from './dns';
import { secrets, setSecret } from './secrets';

// NOTE: created by hand, since a service account can't create projects without a GCP organization
export const FIREBASE_PROJECT = isProduction ? 'pandoks-prod' : 'pandoks-dev';
// NOTE: android.package in apps/mobile-template/app.json
const MOBILE_TEMPLATE_PACKAGE_NAME = 'com.pandoks.mobiletemplate';

const firebaseApis = Object.entries({
  Firebase: 'firebase.googleapis.com',
  Fcm: 'fcm.googleapis.com',
  Iam: 'iam.googleapis.com',
  ResourceManager: 'cloudresourcemanager.googleapis.com'
}).map(
  ([apiName, service]) =>
    new gcp.projects.Service(`Gcp${apiName}Api`, { project: FIREBASE_PROJECT, service })
);

const firebaseProject = new gcp.firebase.Project(
  'FirebaseProject',
  { project: FIREBASE_PROJECT },
  { dependsOn: firebaseApis }
);

const mobileTemplateAndroidApp = new gcp.firebase.AndroidApp('FirebaseMobileTemplateAndroidApp', {
  project: firebaseProject.project,
  displayName: 'Mobile Template',
  packageName: MOBILE_TEMPLATE_PACKAGE_NAME
});

// NOTE: `sst shell --stage <stage>` hands the template build its google-services.json
new sst.Linkable('FirebaseMobileTemplateAndroidConfig', {
  properties: {
    googleServicesJson: gcp.firebase
      .getAndroidAppConfigOutput({
        project: firebaseProject.project,
        appId: mobileTemplateAndroidApp.appId
      })
      .configFileContents.apply((contents) => Buffer.from(contents, 'base64').toString())
  }
});

const pushServiceAccount = new gcp.serviceaccount.Account(
  'FirebasePushServiceAccount',
  { project: FIREBASE_PROJECT, accountId: 'push' },
  { dependsOn: firebaseApis }
);

// NOTE: the narrowest predefined role with cloudmessaging.messages.create, which FCM v1 sends need
new gcp.projects.IAMMember('FirebasePushMessagingRole', {
  project: firebaseProject.project,
  role: 'roles/firebasecloudmessaging.admin',
  member: pushServiceAccount.member
});

const pushServiceAccountKey = new gcp.serviceaccount.Key('FirebasePushServiceAccountKey', {
  serviceAccountId: pushServiceAccount.name
});

$resolve([secrets.firebase.ServiceAccountJson.value, pushServiceAccountKey.privateKey]).apply(
  ([secretServiceAccountJson, privateKey]) => {
    const serviceAccountJson = Buffer.from(privateKey, 'base64').toString();
    if (secretServiceAccountJson !== serviceAccountJson) {
      setSecret(secrets.firebase.ServiceAccountJson.name, serviceAccountJson);
    }
  }
);
