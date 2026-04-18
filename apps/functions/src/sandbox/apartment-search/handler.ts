import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { Resource } from 'sst';
import { TARGETS, DEFAULT_RULES } from './config';
import { scrapeAll } from './scrapers';
import { processResults, persistState } from './status';
import type { AlertMatch } from './types';

const lambda = new LambdaClient({});

const RECIPIENT_PHONE_NUMBERS = [
  Resource.KwokPhoneNumber.value,
  Resource.MichellePhoneNumber.value
];

function formatAlertMessage(alerts: AlertMatch[]): string {
  const lines: string[] = ['🏠 Apartment Alert'];

  const grouped = new Map<string, AlertMatch[]>();
  for (const alert of alerts) {
    const key = alert.targetName;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(alert);
  }

  for (const [property, propertyAlerts] of grouped) {
    lines.push('');
    lines.push(`📍 ${property}`);

    for (const alert of propertyAlerts) {
      const unit = alert.unit;
      const bed = Number.parseFloat(unit.bedrooms ?? '');
      const bedLabel = Number.isNaN(bed) ? '' : bed === 0 ? 'studio' : `${bed}bd`;
      const dateLabel = unit.priceDate ? `move-in ${unit.priceDate.slice(5)}` : '';
      const unitInfo = [
        `Unit ${unit.number}`,
        bedLabel,
        unit.sqft ? `${unit.sqft}sqft` : '',
        unit.price,
        dateLabel
      ]
        .filter(Boolean)
        .join(' · ');

      const star = alert.watched ? ' ⭐' : '';
      if (alert.change === 'new') {
        lines.push(`  🆕 ${unitInfo}${star}`);
      } else if (alert.change === 'price_down') {
        lines.push(`  📉 ${unitInfo} (was ${alert.previousPrice})${star}`);
      } else {
        lines.push(`  📈 ${unitInfo} (was ${alert.previousPrice})${star}`);
      }
    }
  }

  return lines.join('\n');
}

export const notifierHandler = async () => {
  console.log(`Scraping ${TARGETS.length} properties...`);

  const targets = TARGETS.map((t) => ({
    ...t,
    rules: t.rules ?? DEFAULT_RULES
  }));

  const results = await scrapeAll(targets, 70_000);

  const totalUnits = results.reduce((sum, r) => sum + r.units.length, 0);
  console.log(`Scraped ${results.length} properties, found ${totalUnits} total units`);

  const { alerts, toWrite } = await processResults(targets, results);

  if (!alerts.length) {
    await persistState(toWrite);
    console.log('No new alerts');
    return { statusCode: 200, body: 'No alerts' };
  }

  console.log(`Found ${alerts.length} alerts, sending SMS...`);
  const message = formatAlertMessage(alerts);

  const sends = await Promise.allSettled(
    RECIPIENT_PHONE_NUMBERS.map(async (phoneNumber) => {
      const response = await lambda.send(
        new InvokeCommand({
          FunctionName: process.env.TEXT_FUNCTION_ARN!,
          InvocationType: 'RequestResponse',
          Payload: new TextEncoder().encode(JSON.stringify({ phoneNumber, message }))
        })
      );
      if (response.FunctionError) {
        const body = response.Payload ? new TextDecoder().decode(response.Payload) : '';
        throw new Error(`text lambda ${response.FunctionError}: ${body}`);
      }
    })
  );

  const failures: string[] = [];
  for (let i = 0; i < sends.length; i++) {
    const result = sends[i];
    const masked = `***${RECIPIENT_PHONE_NUMBERS[i].slice(-4)}`;
    if (result.status === 'fulfilled') {
      console.log(`SMS sent to ${masked}`);
    } else {
      console.error(`SMS failed to ${masked}`, result.reason);
      failures.push(
        `${masked}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `SMS delivery incomplete (${failures.length}/${sends.length} failed); skipping state persist so next run retries. Failures: ${failures.join('; ')}`
    );
  }

  await persistState(toWrite);
  return {
    statusCode: 200,
    body: `Sent ${alerts.length} alerts to ${sends.length} recipients`
  };
};
