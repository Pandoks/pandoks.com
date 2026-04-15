import {
  ConflictException,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  SchedulerClient,
  UpdateScheduleCommand
} from '@aws-sdk/client-scheduler';
import { Client, isFullPage } from '@notionhq/client';
import type { PageObjectResponse } from '@notionhq/client';
import { createHash } from 'node:crypto';
import { Resource } from 'sst';
import { PHONE_NUMBER_MAPPINGS, type Users } from '../../lib/pii';
import type { NotionWebhookEvent } from './webhook';

const notion = new Client({ auth: Resource.NotionApiKey.value, notionVersion: '2026-03-11' });
const schedulerClient = new SchedulerClient({});
const ALL_PHONE_NUMBERS = [...new Set(Object.values(PHONE_NUMBER_MAPPINGS))];
const NAME_PROPERTY_KEYS = ['Assigned To', 'Person', 'Assignee'];

function scheduleName(pageId: string, phoneNumber: string): string {
  const phoneHash = createHash('sha256').update(phoneNumber).digest('hex');
  const prefix = `schedule-notion-text-${pageId}-`;
  return `${prefix}${phoneHash.slice(0, 64 - prefix.length)}`;
}

async function upsertSchedule(
  name: string,
  scheduleTime: string,
  input: string,
  phoneNumber: string
): Promise<void> {
  try {
    await schedulerClient.send(
      new CreateScheduleCommand({
        Name: name,
        FlexibleTimeWindow: { Mode: 'OFF' },
        ScheduleExpression: `at(${scheduleTime})`,
        State: 'ENABLED',
        GroupName: process.env.SCHEDULER_GROUP_NAME!,
        ActionAfterCompletion: 'DELETE',
        Target: {
          Arn: process.env.TEXT_FUNCTION_ARN!,
          RoleArn: process.env.SCHEDULER_INVOKE_ROLE_ARN!,
          Input: input
        }
      })
    );
    console.log(`Created Notion reminder schedule: ${name} (***${phoneNumber.slice(-4)})`);
  } catch (e) {
    if (e instanceof ConflictException) {
      await schedulerClient.send(
        new UpdateScheduleCommand({
          Name: name,
          FlexibleTimeWindow: { Mode: 'OFF' },
          ScheduleExpression: `at(${scheduleTime})`,
          State: 'ENABLED',
          GroupName: process.env.SCHEDULER_GROUP_NAME!,
          ActionAfterCompletion: 'DELETE',
          Target: {
            Arn: process.env.TEXT_FUNCTION_ARN!,
            RoleArn: process.env.SCHEDULER_INVOKE_ROLE_ARN!,
            Input: input
          }
        })
      );
      console.log(`Updated Notion reminder schedule: ${name} (***${phoneNumber.slice(-4)})`);
    } else {
      throw e;
    }
  }
}

export async function handleTextReminder(body: NotionWebhookEvent): Promise<void> {
  const pageId = body.entity.id;

  if (body.type === 'page.properties_updated' || body.type === 'page.created') {
    const response = await notion.pages.retrieve({ page_id: pageId });
    if (!isFullPage(response)) return;

    const notificationTime =
      response.properties['Notification Time']?.type === 'date'
        ? response.properties['Notification Time'].date?.start
        : undefined;
    if (!notificationTime || new Date(notificationTime).getTime() <= Date.now()) {
      for (const phone of ALL_PHONE_NUMBERS) {
        await deleteSchedule(scheduleName(pageId, phone));
      }
      return;
    }

    let peopleProperty:
      | Extract<PageObjectResponse['properties'][string], { type: 'people' }>
      | undefined;
    for (const key of NAME_PROPERTY_KEYS) {
      const candidate = response.properties[key];
      if (candidate?.type === 'people') {
        peopleProperty = candidate;
        break;
      }
    }

    const users =
      peopleProperty?.people.flatMap((personOrGroup) => {
        const name =
          'name' in personOrGroup && typeof personOrGroup.name === 'string'
            ? personOrGroup.name
            : undefined;
        return name && (Object.keys(PHONE_NUMBER_MAPPINGS) as Users[]).includes(name as Users)
          ? [name as Users]
          : [];
      }) ?? [];

    const phoneNumbers = [...new Set(users.map((user) => PHONE_NUMBER_MAPPINGS[user]))];
    if (!phoneNumbers.length) {
      for (const phone of ALL_PHONE_NUMBERS) {
        await deleteSchedule(scheduleName(pageId, phone));
      }
      return;
    }

    let titleProperty:
      | Extract<PageObjectResponse['properties'][string], { type: 'title' }>
      | undefined;
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
    const messageText = message.join('\n');

    const scheduleTime = new Date(notificationTime).toISOString().split('.')[0];

    for (const phoneNumber of phoneNumbers) {
      const name = scheduleName(pageId, phoneNumber);
      const input = JSON.stringify({ phoneNumber, message: messageText });
      await upsertSchedule(name, scheduleTime, input, phoneNumber);
    }

    for (const phone of ALL_PHONE_NUMBERS) {
      if (!phoneNumbers.includes(phone)) {
        await deleteSchedule(scheduleName(pageId, phone));
      }
    }
  } else if (body.type === 'page.deleted') {
    for (const phone of ALL_PHONE_NUMBERS) {
      await deleteSchedule(scheduleName(pageId, phone));
    }
  }
}

const deleteSchedule = async (name: string) => {
  try {
    await schedulerClient.send(
      new DeleteScheduleCommand({
        Name: name,
        GroupName: process.env.SCHEDULER_GROUP_NAME!
      })
    );
    console.log(`Deleted Notion reminder schedule: ${name}`);
  } catch (e) {
    if (e instanceof Error && e.name === 'ResourceNotFoundException') return;
    throw e;
  }
};
