import { nodeVersion, textFunction } from '../api';
import { secrets } from '../secrets';

const apartmentSearchKV = new sst.aws.Dynamo('ApartmentSearchKV', {
  fields: {
    unitKey: 'string'
  },
  primaryIndex: { hashKey: 'unitKey' },
  ttl: 'ttl'
});

const scraperFunction = new sst.aws.Function('ApartmentScraper', {
  handler: 'apps/functions/src/sandbox/apartment-search/handler.notifierHandler',
  runtime: nodeVersion,
  timeout: '120 seconds',
  memory: '256 MB',
  url: false,
  concurrency: { reserved: 1 },
  link: [
    apartmentSearchKV,
    secrets.personal.KwokPhoneNumber,
    secrets.personal.MichellePhoneNumber,
    secrets.oxylabs.webunblocker.Username,
    secrets.oxylabs.webunblocker.Password
  ],
  permissions: [
    {
      actions: ['lambda:InvokeFunction'],
      resources: [textFunction.arn]
    }
  ],
  environment: {
    TEXT_FUNCTION_ARN: textFunction.arn
  }
});

new sst.aws.CronV2('ApartmentScraperCron', {
  function: scraperFunction,
  schedule: 'rate(5 minutes)'
});
