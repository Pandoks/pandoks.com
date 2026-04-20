import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { Resource } from 'sst';
import { TARGETS } from './config';
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
      } else if (alert.change === 'price_up') {
        lines.push(`  📈 ${unitInfo} (was ${alert.previousPrice})${star}`);
      } else {
        lines.push(`  🚫 ${unitInfo} (above cap, was ${alert.previousPrice})${star}`);
      }
    }
  }

  return lines.join('\n');
}

async function sendSms(phoneNumber: string, message: string) {
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
}

export const notifierHandler = async () => {
  console.log(`Scraping ${TARGETS.length} properties...`);

  const { results, failures } = await scrapeAll(TARGETS, 70_000);

  const totalUnits = results.reduce((sum, r) => sum + r.units.length, 0);
  console.log(`Scraped ${results.length} properties, found ${totalUnits} total units`);

  const { alerts, toWrite, alertToRecord } = await processResults(
    TARGETS,
    results,
    RECIPIENT_PHONE_NUMBERS.length
  );

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  if (alerts.length) {
    console.log(`Found ${alerts.length} alerts, sending SMS...`);
    for (const phoneNumber of RECIPIENT_PHONE_NUMBERS) {
      const masked = `***${phoneNumber.slice(-4)}`;
      const pending = alerts.filter((a) => !(a.alreadySent ?? []).includes(phoneNumber));
      if (!pending.length) {
        skipped += alerts.length;
        continue;
      }

      const message = formatAlertMessage(pending);
      try {
        await sendSms(phoneNumber, message);
        console.log(`SMS sent to ${masked} (${pending.length} alerts)`);
        sent += pending.length;
        for (const alert of pending) {
          const record = alertToRecord.get(alert);
          if (!record) continue;
          record.sentTo = [...(record.sentTo ?? []), phoneNumber];
        }
      } catch (err) {
        failed += pending.length;
        console.error(`SMS failed to ${masked}`, err);
      }
    }
  } else {
    console.log('No new alerts');
  }

  await persistState(toWrite);

  if (failures.length || failed > 0) {
    throw new Error(
      `notifier partial failure: sent=${sent} skipped=${skipped} sms_failed=${failed} scrape_failures=${failures
        .map((f) => f.target)
        .join(',')}`
    );
  }

  return {
    statusCode: 200,
    body: `sent=${sent} skipped=${skipped}`
  };
};
