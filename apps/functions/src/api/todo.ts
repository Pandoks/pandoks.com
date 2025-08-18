import { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { PageObjectResponse } from '@notionhq/client';
import { Resource } from 'sst';
import twilio from 'twilio';
import { MessageInstance } from 'twilio/lib/rest/api/v2010/account/message';

const NAME_PROPERTY_KEYS = ['Assigned To', 'Person', 'Buyer', 'Assignee'];

const PHONE_NUMBERS = {
  'Manda Wong': Resource.MichellePhoneNumber.value,
  'BLAINE Manda Wong': Resource.MichellePhoneNumber.value,
  Pandoks: Resource.KwokPhoneNumber.value
};

const twilioClient = twilio(Resource.TwilioAccountSid.value, Resource.TwilioAuthToken.value);

/**
 * Request Requirements:
 *  - Method: POST
 *  - Headers:
 *    - auth: NOTION_TODO_REMIND_AUTH
 *    - people?: person1,person2,person3
 *    - message?: message
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

  try {
    let texts: Promise<MessageInstance>[] = [];
    for (const phoneNumber of phoneNumbers) {
      texts.push(
        twilioClient.messages.create({
          body: event.headers.message || '📝 Todo Reminder',
          from: Resource.TwilioPhoneNumber.value,
          to: phoneNumber
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
