import {
  ConflictException,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  SchedulerClient,
  UpdateScheduleCommand
} from '@aws-sdk/client-scheduler';
import { Client, isFullPage } from '@notionhq/client';
import type { PageObjectResponse } from '@notionhq/client';
import { Resource } from 'sst';
import { PHONE_NUMBER_MAPPINGS, type Users } from '../../lib/pii';
import type { NotionWebhookEvent } from './webhook';

const notion = new Client({ auth: Resource.NotionApiKey.value, notionVersion: '2026-03-11' });
const schedulerClient = new SchedulerClient({});
const ALL_USERS = Object.keys(PHONE_NUMBER_MAPPINGS) as Users[];
const NAME_PROPERTY_KEYS = ['Assigned To', 'Person', 'Assignee'];

export async function handleTextReminder(body: NotionWebhookEvent): Promise<void> {
  const pageId = body.entity.id;

  if (body.type === 'page.properties_updated' || body.type === 'page.created') {
    const response = await notion.pages.retrieve({ page_id: pageId });
    if (!isFullPage(response)) return;

    const name = `schedule-notion-text-${pageId}`;
    const notificationTime =
      response.properties['Notification Time']?.type === 'date'
        ? response.properties['Notification Time'].date?.start
        : undefined;
    if (!notificationTime || new Date(notificationTime).getTime() <= Date.now()) {
      await deleteSchedule(name);
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
        return name && ALL_USERS.includes(name as Users) ? [name as Users] : [];
      }) ?? [];
    if (!users.length) {
      await deleteSchedule(name);
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

    const scheduleTime = new Date(notificationTime).toISOString().split('.')[0];

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
            Input: JSON.stringify({ users, message: message.join('\n') })
          }
        })
      );
      console.log(`Created Notion reminder schedule: ${name}`);
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
              Input: JSON.stringify({ users, message: message.join('\n') })
            }
          })
        );
        console.log(`Updated Notion reminder schedule: ${name}`);
      } else {
        throw e;
      }
    }
  } else if (body.type === 'page.deleted') {
    await deleteSchedule(`schedule-notion-text-${pageId}`);
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
