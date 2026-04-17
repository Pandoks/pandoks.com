import { nodeVersion, textFunction } from '../api';

if ($app.stage === 'production') {
  const apartmentSearchKV = new sst.aws.Dynamo('ApartmentSearchKV', {
    fields: {
      unitKey: 'string'
    },
    primaryIndex: { hashKey: 'unitKey' },
    ttl: 'ttl'
  });

  const scraperFunction = new sst.aws.Function('ApartmentScraperFunction', {
    handler: 'apps/functions/src/sandbox/apartment-search/handler.notifierHandler',
    runtime: nodeVersion,
    timeout: '120 seconds',
    memory: '256 MB',
    url: false,
    link: [apartmentSearchKV],
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
}
