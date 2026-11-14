import { env, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { Client, isFullPage } from '@notionhq/client';
import type { PageObjectResponse } from '@notionhq/client';
import { createHash } from 'node:crypto';
import { PHONE_NUMBER_MAPPINGS, type Users } from '../../lib/pii';
import { sendText } from '../../text';
import type { NotionWebhookEvent } from './webhook';

const notion = new Client({ auth: env.NOTION_API_KEY, notionVersion: '2026-03-11' });
const NAME_PROPERTY_KEYS = ['Assigned To', 'Person', 'Assignee'];
const INSTANCE_ALREADY_EXISTS = 10405;

const ONE_MINUTE = 60_000;

type TextReminder = {
  pageId: string;
  phoneNumber: string;
  notificationTime: string;
  scheduleTime: string;
};

async function getPageReminder(pageId: string) {
  const response = await notion.pages.retrieve({ page_id: pageId });
  if (!isFullPage(response) || response.in_trash) return;

  const notificationTime =
    response.properties['Notification Time']?.type === 'date'
      ? response.properties['Notification Time'].date?.start
      : undefined;
  if (!notificationTime) return;

  let peopleProperty:
    Extract<PageObjectResponse['properties'][string], { type: 'people' }> | undefined;
  for (const key of NAME_PROPERTY_KEYS) {
    const candidate = response.properties[key];
    if (candidate?.type === 'people') {
      peopleProperty = candidate;
      break;
    }
  }

  const knownUsers = Object.keys(PHONE_NUMBER_MAPPINGS) as Users[];
  const users =
    peopleProperty?.people.flatMap((personOrGroup): Users[] => {
      const name =
        'name' in personOrGroup && typeof personOrGroup.name === 'string'
          ? personOrGroup.name
          : undefined;
      return name && knownUsers.includes(name as Users) ? [name as Users] : [];
    }) ?? [];

  let titleProperty:
    Extract<PageObjectResponse['properties'][string], { type: 'title' }> | undefined;
  for (const property of Object.values(response.properties)) {
    if (property.type === 'title') {
      titleProperty = property;
      break;
    }
  }

  const message = ['🚨 Notion Reminder:'];
  const title = titleProperty?.title[0]?.plain_text;
  if (title) message.push(title);
  message.push(response.url);

  return {
    notificationTime,
    phoneNumbers: [...new Set(users.map((user) => PHONE_NUMBER_MAPPINGS[user]))],
    message: message.join('\n')
  };
}

// NOTE: nothing cancels a reminder; it re-reads its page on waking and texts only if still due
export class TextReminderWorkflow extends WorkflowEntrypoint<Env, TextReminder> {
  async run({ payload }: WorkflowEvent<TextReminder>, step: WorkflowStep) {
    await step.sleepUntil('wait for the notification time', new Date(payload.scheduleTime));
    await step.do('text if the reminder is still current', async () => {
      const reminder = await getPageReminder(payload.pageId);
      if (
        reminder?.notificationTime !== payload.notificationTime ||
        !reminder.phoneNumbers.includes(payload.phoneNumber)
      ) {
        return;
      }
      await sendText({ phoneNumber: payload.phoneNumber, message: reminder.message });
    });
  }
}

export async function handleTextReminder(body: NotionWebhookEvent): Promise<void> {
  if (body.type !== 'page.properties_updated' && body.type !== 'page.created') return;

  const pageId = body.entity.id;
  const reminder = await getPageReminder(pageId);
  const fiveMinutes = 5 * ONE_MINUTE;
  if (
    !reminder?.phoneNumbers.length ||
    new Date(reminder.notificationTime).getTime() + fiveMinutes < Date.now()
  ) {
    return;
  }

  const scheduleTime = new Date(
    Math.max(new Date(reminder.notificationTime).getTime(), Date.now() + fiveMinutes)
  ).toISOString();
  const { errors } = await env.TEXT_REMINDER_WORKFLOW.createBatch({
    instances: reminder.phoneNumbers.map((phoneNumber) => ({
      id: createHash('sha256')
        .update(`${pageId}:${phoneNumber}:${reminder.notificationTime}`)
        .digest('hex'),
      params: { pageId, phoneNumber, notificationTime: reminder.notificationTime, scheduleTime }
    }))
  });

  const failures = errors.filter((error) => error.code !== INSTANCE_ALREADY_EXISTS);
  if (failures.length) {
    throw new Error(
      `Text reminder scheduling failed: ${failures.map((failure) => failure.message).join(', ')}`
    );
  }
  console.log(`Scheduled ${reminder.phoneNumbers.length - errors.length} Notion text reminders`);
}
