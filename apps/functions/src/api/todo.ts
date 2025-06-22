import { PublishCommand, PublishCommandOutput, SNS } from '@aws-sdk/client-sns';
import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { Resource } from 'sst';

const sns = new SNS({ region: 'us-west-1' });
const phoneNumbers = {
  'Manda Wong': Resource.MichellePhoneNumber.value,
  Pandoks: Resource.KwokPhoneNumber.value
};

export const textTodoHandler = async (event: APIGatewayProxyEventV2) => {
  console.log('event:', event);
  if (event.requestContext.http.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  if (event.headers.auth !== Resource.NotionTodoRemindAuth.value) {
    return new Response('Unauthorized', { status: 401 });
  }

  const assignedTo = JSON.parse(event.body!).data.properties['Assigned To'].people.map(
    (person) => person.name
  );
  console.log('Assigned To:', assignedTo);
  try {
    let smsMessages: Promise<PublishCommandOutput>[] = [];
    for (const person of assignedTo) {
      console.log('Sending SMS to', person, 'at', phoneNumbers[person]);
      smsMessages.push(
        sns.send(new PublishCommand({ Message: 'hi', PhoneNumber: phoneNumbers[person] }))
      );
    }
    const smsResponses = await Promise.all(smsMessages);
    for (const smsResponse of smsResponses) {
      console.log('SMS Response:', smsResponse);
    }

    return new Response('OK', { status: 200 });
  } catch (e) {
    console.error('ERROR:', e);
    return new Response('Internal Server Error', { status: 500 });
  }
};
