import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as cloudflare from '@pulumi/cloudflare';
import { buildSync } from 'esbuild';

export function createBucket({
  id,
  name,
  forceDestroy = false,
  lifecycleRules,
  options
}: {
  id: string;
  name: string;
  forceDestroy?: boolean;
  lifecycleRules?: aws.types.input.s3.BucketLifecycleConfigurationRule[];
  options?: pulumi.CustomResourceOptions;
}) {
  const providerOptions = options?.provider ? { provider: options.provider } : undefined;
  const bucket = new aws.s3.Bucket(id, { bucket: name, forceDestroy }, options);
  const publicAccessBlock = new aws.s3.BucketPublicAccessBlock(
    `${id}PublicAccessBlock`,
    {
      bucket: bucket.bucket,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true
    },
    providerOptions
  );
  const policy = new aws.s3.BucketPolicy(
    `${id}Policy`,
    {
      bucket: bucket.bucket,
      policy: pulumi.jsonStringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Deny',
            Action: 's3:*',
            Resource: [pulumi.interpolate`${bucket.arn}/*`, bucket.arn],
            Principal: '*',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } }
          }
        ]
      })
    },
    { ...providerOptions, dependsOn: publicAccessBlock }
  );
  if (lifecycleRules?.length) {
    new aws.s3.BucketLifecycleConfiguration(
      `${id}Lifecycle`,
      { bucket: bucket.bucket, rules: lifecycleRules },
      { ...providerOptions, dependsOn: policy }
    );
  }
  return bucket;
}

export function createValidatedCertificate({
  id,
  domainName,
  zoneId
}: {
  id: string;
  domainName: pulumi.Input<string>;
  zoneId: pulumi.Input<string>;
}) {
  const certificate = new aws.acm.Certificate(id, {
    domainName,
    validationMethod: 'DNS'
  });
  const validationOption = certificate.domainValidationOptions[0];
  const validationRecord = new cloudflare.DnsRecord(`${id}ValidationRecord`, {
    zoneId,
    name: validationOption.resourceRecordName.apply((name) => name.replace(/\.$/, '')),
    type: validationOption.resourceRecordType,
    content: validationOption.resourceRecordValue.apply((value) => value.replace(/\.$/, '')),
    proxied: false,
    ttl: 60
  });
  return new aws.acm.CertificateValidation(`${id}Validation`, {
    certificateArn: certificate.arn,
    validationRecordFqdns: [validationRecord.name]
  });
}

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
