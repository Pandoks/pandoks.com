import { PageObjectResponse } from '@notionhq/client';

export type NotionAutomationSource = {
  type: 'automation';
  automation_id: string;
  action_id: string;
  event_id: string;
  user_id: string;
  attempt: number;
};

export type NotionWebhookBody = {
  source: NotionAutomationSource;
  data: PageObjectResponse;
};

export type PersonProperty = {
  id: string;
  type: string;
  number: number | null;
  people: Person[];
};

export type Person = {
  object: 'string';
  id: string;
  name: string;
  avatar_url: string;
  type: 'person';
  person: {
    email: string;
  };
};

export type NotionDate = {
  id: string;
  type: string;
  date: {
    start: string;
    end: string | null;
    time_zone: string | null;
  };
};
