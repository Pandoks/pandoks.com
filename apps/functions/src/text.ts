import twilio from 'twilio';
import type { TextSmsEnvironment } from './env';

const env = process.env as unknown as TextSmsEnvironment;
const twilioClient = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

export const sendTextHandler = async (event: { phoneNumber: string; message: string }) => {
  await twilioClient.messages.create({
    body: event.message,
    from: env.TWILIO_PHONE_NUMBER,
    to: event.phoneNumber,
    messagingServiceSid: env.TWILIO_NOTION_MESSAGING_SERVICE_SID
  });
};
