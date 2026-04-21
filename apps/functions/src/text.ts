import twilio from 'twilio';
import { Resource } from 'sst';

const twilioClient = twilio(Resource.TwilioAccountSid.value, Resource.TwilioAuthToken.value);

export const sendTextHandler = async (event: { phoneNumber: string; message: string }) => {
  await twilioClient.messages.create({
    body: event.message,
    from: Resource.TwilioPhoneNumber.value,
    to: event.phoneNumber,
    messagingServiceSid: Resource.TwilioNotionMessagingServiceSid.value
  });
};
