import { Resource } from 'sst';

export const deployHandler = async (request: Request) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const authHeader = request.headers.get('auth');
  if (authHeader !== Resource.NotionBlogDeployAuth.value) {
    return new Response('Unauthorized', { status: 401 });
  }

  const stage = request.headers.get('stage');
  if (!['production', 'pandoks'].includes(stage)) {
    return new Response('Bad Request', { status: 400 });
  }

  try {
    const githubResponse = await fetch(
      'https://api.github.com/repos/pandoks/pandoks.com/actions/workflows/deploy-web.yaml/dispatches',
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github.v3+json',
          Authorization: `token ${Resource.GithubPersonalAccessToken.value}`,
          'Content-Type': 'application/json',
          'User-Agent': 'api.pandoks.com'
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: {
            stage: stage
          }
        })
      }
    );

    if (!githubResponse.ok) {
      return new Response('Internal Server Error', { status: 500 });
    }

    return new Response('OK', { status: 200 });
  } catch (e) {
    return new Response('Internal Server Error', { status: 500 });
  }
};
