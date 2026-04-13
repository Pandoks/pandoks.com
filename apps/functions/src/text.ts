import twilio from 'twilio';
import { MessageInstance } from 'twilio/lib/rest/api/v2010/account/message';
import { Resource } from 'sst';
import { PHONE_NUMBER_MAPPINGS, Users } from './lib/pii';

const twilioClient = twilio(Resource.TwilioAccountSid.value, Resource.TwilioAuthToken.value);

export const sendTextHandler = async (event: { users: Users[]; message: string }) => {
  if (!event.users.length) {
    return true;
  }

  let phoneNumbers: string[] = [];
  for (const user of event.users) {
    phoneNumbers.push(PHONE_NUMBER_MAPPINGS[user]);
  }

  try {
    let texts: Promise<MessageInstance>[] = [];
    for (const phoneNumber of phoneNumbers) {
      texts.push(
        twilioClient.messages.create({
          body: event.message,
          from: Resource.TwilioPhoneNumber.value,
          to: phoneNumber,
          messagingServiceSid: Resource.TwilioNotionMessagingServiceSid.value
        })
      );
    }
    const settled = await Promise.allSettled(texts);
    for (const settledText of settled) {
      if (settledText.status === 'rejected') {
        console.error('Failed to send SMS', { error: settledText.reason });
      }
    }

    return true;
  } catch (e) {
    console.error('Unexpected SMS handler failure', { error: e });
    return false;
  }
};
