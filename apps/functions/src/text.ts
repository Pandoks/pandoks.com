import { env } from 'cloudflare:workers';

export async function sendText({ phoneNumber, message }: { phoneNumber: string; message: string }) {
  const twilioResponse = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`
      },
      body: new URLSearchParams({
        Body: message,
        From: env.TWILIO_PHONE_NUMBER,
        To: phoneNumber,
        MessagingServiceSid: env.TWILIO_NOTION_MESSAGING_SERVICE_SID
      })
    }
  );

  if (!twilioResponse.ok) {
    throw new Error(`Twilio send failed: ${twilioResponse.status}`);
  }
}
