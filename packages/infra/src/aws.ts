import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { buildSync } from 'esbuild';

export function createFunction({
  id,
  name,
  entryPoint,
  handler,
  timeout,
  environment,
  inlinePolicy
}: {
  id: string;
  name: string;
  entryPoint: string;
  handler: string;
  timeout: number;
  environment: Record<string, pulumi.Input<string>>;
  inlinePolicy?: pulumi.Input<string>;
}) {
  const logGroup = new aws.cloudwatch.LogGroup(`${id}LogGroup`, {
    name: `/aws/lambda/${name}`,
    retentionInDays: 30
  });
  const role = new aws.iam.Role(`${id}Role`, {
    name,
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'lambda.amazonaws.com' }),
    managedPolicyArns: [aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole],
    inlinePolicies: inlinePolicy ? [{ name: 'inline', policy: inlinePolicy }] : []
  });

  const [bundle] = buildSync({
    entryPoints: [entryPoint],
    bundle: true,
    minify: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    write: false
  }).outputFiles;

  return new aws.lambda.Function(`${id}Function`, {
    name,
    runtime: aws.lambda.Runtime.NodeJS24dX,
    handler: `index.${handler}`,
    role: role.arn,
    timeout,
    memorySize: 1024,
    code: new pulumi.asset.AssetArchive({
      'index.js': new pulumi.asset.StringAsset(bundle.text)
    }),
    environment: { variables: environment },
    loggingConfig: { logFormat: 'Text', logGroup: logGroup.name }
  });
}
