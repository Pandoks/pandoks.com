import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { TARGETS, DEFAULT_RULES } from './config';
import { scrapeAll } from './scrapers';
import { processResults, persistState } from './status';
import type { AlertMatch } from './types';

const lambda = new LambdaClient({});

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
      const unitInfo = [
        `Unit ${unit.number}`,
        unit.bedrooms ? `${unit.bedrooms}bd` : '',
        unit.sqft ? `${unit.sqft}sqft` : '',
        unit.price
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

  const results = await scrapeAll(targets, 25_000);

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

  await lambda.send(
    new InvokeCommand({
      FunctionName: process.env.TEXT_FUNCTION_ARN!,
      InvocationType: 'RequestResponse',
      Payload: new TextEncoder().encode(
        JSON.stringify({
          users: ['Pandoks', 'Manda Wong'],
          message
        })
      )
    })
  );

  await persistState(toWrite);
  console.log('SMS sent successfully');
  return { statusCode: 200, body: `Sent ${alerts.length} alerts` };
};
