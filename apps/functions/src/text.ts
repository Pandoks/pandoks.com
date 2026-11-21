import twilio from 'twilio';

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

export const sendTextHandler = async (event: { phoneNumber: string; message: string }) => {
  await twilioClient.messages.create({
    body: event.message,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: event.phoneNumber,
    messagingServiceSid: process.env.TWILIO_NOTION_MESSAGING_SERVICE_SID
  });
};
