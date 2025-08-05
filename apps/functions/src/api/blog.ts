import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { Resource } from 'sst';

export const deployHandler = async (event: APIGatewayProxyEventV2) => {
  if (event.requestContext.http.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  if (event.headers.auth !== Resource.NotionBlogDeployAuth.value) {
    return new Response('Unauthorized', { status: 401 });
  }

  const stage = event.headers.stage || '';
  if (!['production', 'pandoks'].includes(stage)) {
    return new Response('Bad Request', { status: 400 });
  }

  try {
    const githubResponse = await fetch(process.env.GITHUB_DEPLOY_URL!, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github.v3+json',
        Authorization: `token ${Resource.GithubPersonalAccessToken.value}`,
        'Content-Type': 'application/json',
        'User-Agent': process.env.DOMAIN!
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          stage: stage
        }
      })
    });

    if (!githubResponse.ok) {
      return new Response('Internal Server Error', { status: 500 });
    }

    return new Response('OK', { status: 200 });
  } catch (e) {
    return new Response('Internal Server Error', { status: 500 });
  }
};
