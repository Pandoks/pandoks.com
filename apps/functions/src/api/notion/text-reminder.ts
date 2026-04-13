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

const notion = new Client({ auth: Resource.NotionApiKey.value });
const schedulerClient = new SchedulerClient({});
const ALL_USERS = Object.keys(PHONE_NUMBER_MAPPINGS) as Users[];
const NAME_PROPERTY_KEYS = ['Assigned To', 'Person', 'Assignee'];

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
