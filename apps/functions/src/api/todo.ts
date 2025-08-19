import { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { PageObjectResponse } from '@notionhq/client';
import { Resource } from 'sst';
import twilio from 'twilio';
import { MessageInstance } from 'twilio/lib/rest/api/v2010/account/message';
import { CreateScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';

const NAME_PROPERTY_KEYS = ['Assigned To', 'Person', 'Buyer', 'Assignee'];

const PHONE_NUMBERS = {
  'Manda Wong': Resource.MichellePhoneNumber.value,
  'BLAINE Manda Wong': Resource.MichellePhoneNumber.value,
  Pandoks: Resource.KwokPhoneNumber.value
};

const twilioClient = twilio(Resource.TwilioAccountSid.value, Resource.TwilioAuthToken.value);
const schedulerClient = new SchedulerClient({});

/**
 * TODO:
 *  - handle editing
 *  - handle deleting
 * Request Requirements:
 *  - Method: POST
 *  - Headers:
 *    - auth: NOTION_TODO_REMIND_AUTH
 *    - people?: person1,person2,person3
 *    - message?: message
 *    - TODO: event?: created | edited | deleted = created
 *    - notification-time?: ISO 8601 date
 *        NOTE: Doesn't include milliseconds
 *          Format: YYYY-MM-DDTHH:mm:ssZ or YYYY-MM-DDTHH:mm:ss+-HH:MM
 *          Example: 2022-01-01T00:00:00-08:00
 *          YYYY: year, MM: month, DD: day, HH: hour, mm: minute, ss: second, +-/Z: offset
 *          PST: -08:00, EST: -05:00, UTC: Z
 *  - Body:
 *    - data?:
 *      - properties?:
 *        - Assigned To?: person1,person2,person3
 *        - Person?: person1,person2,person3
 *        - Buyer?: person1,person2,person3
 *        - Assignee?: person1,person2,person3
 *        - Notification Time?: ISO 8601 date
 */
export const textTodoHandler = async (event: APIGatewayProxyEventV2) => {
  if (event.requestContext.http.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  if (event.headers.auth !== Resource.NotionTodoRemindAuth.value) {
    return new Response('Unauthorized', { status: 401 });
  }

  let phoneNumbers: string[] = [];

  if (event.headers.people) {
    const people = event.headers.people.split(',');
    for (const person of people) {
      if (PHONE_NUMBERS.hasOwnProperty(person)) {
        phoneNumbers.push(PHONE_NUMBERS[person]);
      }
    }
  }

  const responseBody: NotionWebhookBody = JSON.parse(event.body!);
  const properties = responseBody.data.properties;
  let people: Person[] = [];
  for (const key of NAME_PROPERTY_KEYS) {
    if (properties.hasOwnProperty(key)) {
      people.push(...(properties[key] as PersonProperty).people);
    }
  }
  for (const person of people) {
    if (
      PHONE_NUMBERS.hasOwnProperty(person.name) &&
      !phoneNumbers.includes(PHONE_NUMBERS[person.name])
    ) {
      phoneNumbers.push(PHONE_NUMBERS[person.name]);
    }
  }

  if (!phoneNumbers.length) {
    return new Response('OK', { status: 200 });
  }

  const notificationTime =
    event.headers['notification-time'] ||
    (properties['Notification Time'] as NotionDate | undefined)?.date.start;

  if (notificationTime) {
    delete event.headers['notification-time'];
    delete properties['Notification Time'];
    const scheduleTime = new Date(notificationTime).toISOString().split('.')[0];
    const name = `schedule-todo-${crypto.randomUUID()}`;

    await schedulerClient.send(
      new CreateScheduleCommand({
        Name: name,
        FlexibleTimeWindow: { Mode: 'OFF' },
        ScheduleExpression: `at(${scheduleTime})`,
        State: 'ENABLED',
        GroupName: process.env.SCHEDULER_GROUP_NAME!,
        ActionAfterCompletion: 'DELETE',
        Target: {
          Arn: process.env.WORKER_ARN!,
          RoleArn: process.env.SCHEDULER_INVOKE_ROLE_ARN!,
          Input: JSON.stringify(event)
        }
      })
    );
    return new Response('OK', { status: 200 });
  }

  return await sendText(phoneNumbers, event.headers.message || '📝 Todo Reminder');
};

const sendText = async (phoneNumbers: string[], message: string) => {
  try {
    let texts: Promise<MessageInstance>[] = [];
    for (const phoneNumber of phoneNumbers) {
      texts.push(
        twilioClient.messages.create({
          body: message,
          from: Resource.TwilioPhoneNumber.value,
          to: phoneNumber,
          messagingServiceSid: Resource.TwilioNotionMessagingServiceSid.value
        })
      );
    }
    const settled = await Promise.allSettled(texts);
    for (const settledText of settled) {
      if (settledText.status === 'rejected') {
        console.error('ERROR:', settledText.reason);
      }
    }

    return new Response('OK', { status: 200 });
  } catch (e) {
    console.error('ERROR:', e);
    return new Response('Internal Server Error', { status: 500 });
  }
};

/** ========== TYPES ========== */
type NotionAutomationSource = {
  type: 'automation';
  automation_id: string;
  action_id: string;
  event_id: string;
  user_id: string;
  attempt: number;
};

type NotionWebhookBody = {
  source: NotionAutomationSource;
  data: PageObjectResponse;
};

type PersonProperty = {
  id: string;
  type: string;
  number: number | null;
  people: Person[];
};

type Person = {
  object: 'string';
  id: string;
  name: string;
  avatar_url: string;
  type: 'person';
  person: {
    email: string;
  };
};

type NotionDate = {
  id: string;
  type: string;
  date: {
    start: string;
    end: string | null;
    time_zone: string | null;
  };
};
