import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { Resource } from 'sst';
import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  SchedulerClient
} from '@aws-sdk/client-scheduler';
import { NotionDate, NotionWebhookBody, PersonProperty } from './notion';

const NAME_PROPERTY_KEYS = ['Assigned To', 'Person', 'Buyer', 'Assignee'];
const TITLE_PROPERTY_KEYS = ['Title', 'Name', 'Task', 'Reminder'];
const DESCRIPTION_PROPERTY_KEYS = ['Description', 'Note'];
const DUE_DATE_PROPERTY_KEYS = ['Due Date', 'Deadline'];
const DELETE_EVENT = 'delete';

const schedulerClient = new SchedulerClient({});

/**
 * Request Requirements:
 *  - Method: POST
 *  - Headers:
 *    - auth: NOTION_TODO_REMIND_AUTH
 *    - event?: DELETE_EVENT
 *  - Body:
 *    - data?:
 *      - properties?:
 *        - Notification Time?: ISO 8601 date <
 *        - Assigned To | Person | Buyer | Assignee?: person1,person2,person3 <
 *        - Title | Name | Task?: title
 *        - Description | Note?: description
 *        - Due Date | Deadline?: ISO 8601 date
 */
export const scheduleTextHandler = async (event: APIGatewayProxyEventV2) => {
  if (event.requestContext.http.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  if (event.headers.auth !== Resource.NotionAuthToken.value) {
    return new Response('Unauthorized', { status: 401 });
  }

  const responseBody: NotionWebhookBody = JSON.parse(event.body!);
  const name = `schedule-todo-reminder-${responseBody.data.id}`;
  if (event.headers.event === DELETE_EVENT) {
    try {
      await schedulerClient.send(
        new DeleteScheduleCommand({
          Name: name,
          GroupName: process.env.SCHEDULER_GROUP_NAME!
        })
      );
    } catch (e) {
      console.error('ERROR:', e);
    }
    return new Response('OK', { status: 200 });
  }

  const properties = responseBody.data.properties;
  const notificationTime = (properties['Notification Time'] as NotionDate | undefined)?.date.start;
  if (!notificationTime) {
    console.log('Notification Time Not Found');
    return new Response('Notification Time Not Found', { status: 200 });
  }
  const notificationDate = new Date(notificationTime);
  const scheduleTime = notificationDate.toISOString().split('.')[0];

  let users: string[] = [];
  for (const nameKey of NAME_PROPERTY_KEYS) {
    if (properties.hasOwnProperty(nameKey)) {
      users = (properties[nameKey] as PersonProperty & { number: number | null }).people.map(
        (person) => person.name
      );
      break;
    }
  }
  if (!users.length) {
    console.log('People Not Found');
    return new Response('People Not Found', { status: 200 });
  }

  const message = constructMessage(responseBody);

  try {
    await schedulerClient.send(
      new DeleteScheduleCommand({
        Name: name,
        GroupName: process.env.SCHEDULER_GROUP_NAME!
      })
    );
  } catch (e) {
    console.log('New schedule creating');
  }
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
        Input: JSON.stringify({ users, message })
      }
    })
  );
  return new Response('OK', { status: 200 });
};

/** ========== HELPERS ========== */
const constructMessage = (body: NotionWebhookBody) => {
  const properties = body.data.properties;
  let message = ['🚨 Reminder:'];

  for (const key of TITLE_PROPERTY_KEYS) {
    if (properties.hasOwnProperty(key)) {
      // @ts-ignore
      message.push(`${properties[key].title[0].plain_text}`);
      break;
    }
  }

  for (const key of DESCRIPTION_PROPERTY_KEYS) {
    if (properties.hasOwnProperty(key)) {
      // @ts-ignore
      message.push(properties[key].rich_text[0].plain_text);
      break;
    }
  }

  for (const key of DUE_DATE_PROPERTY_KEYS) {
    if (properties.hasOwnProperty(key)) {
      // @ts-ignore
      const date = properties[key].date;
      const startDate = formatIsoDate(date.start);
      if (date.end) {
        const endDate = formatIsoDate(date.end);
        message.push(`Due: ${startDate} ~ ${endDate}`);
      } else {
        message.push(`Due: ${startDate}`);
      }
      break;
    }
  }

  message.push(body.data.url);

  return message.join('\n');
};

const formatIsoDate = (isoDate: string) => {
  const date = new Date(isoDate);
  const baseOptions: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: '2-digit',
    year: 'numeric'
  };
  if (!isoDate.includes('T')) {
    return new Intl.DateTimeFormat('en-US', baseOptions).format(date);
  }

  const ianaTimeZone: string = IANA_MAPPING[isoDate.slice(-6)] ?? 'UTC';
  const withTimeOptions: Intl.DateTimeFormatOptions = {
    ...baseOptions,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: ianaTimeZone,
    timeZoneName: 'short'
  };
  const formatted = new Intl.DateTimeFormat('en-US', withTimeOptions).format(date);
  return ianaTimeZone === 'UTC'
    ? formatted.replace(/\s([A-Z]{2,5}|GMT(?:[+-]\d{1,2}(?::\d{2})?)?|UTC)$/, ' (UTC)')
    : formatted;
};

const IANA_MAPPING = {
  Z: 'UTC',
  '+00:00': 'UTC',
  '-08:00': 'America/Los_Angeles',
  '-07:00': 'America/Los_Angeles',
  '-06:00': 'America/Chicago',
  '-05:00': 'America/New_York',
  '-04:00': 'America/New_York',
  '+01:00': 'Europe/Berlin',
  '+02:00': 'Europe/Paris',
  '+03:00': 'Asia/Qatar',
  '+04:00': 'Asia/Dubai',
  '+08:00': 'Asia/Shanghai',
  '+09:00': 'Asia/Tokyo',
  '+10:00': 'Australia/Sydney'
};
