import { readFile } from 'node:fs/promises';

type PullRequestEvent = {
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    base: { sha: string };
    head: { sha: string };
  };
  repository: { url: string };
};

export const event = JSON.parse(
  await readFile(process.env.GITHUB_EVENT_PATH!, 'utf8')
) as PullRequestEvent;
export const pullUrl = `${event.repository.url}/pulls/${event.pull_request.number}`;

export async function requestGithub<ResponseBody>({
  method,
  url,
  body
}: {
  method: string;
  url: string;
  body?: object;
}) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GH_TOKEN!}`,
      'X-GitHub-Api-Version': '2026-03-10'
    },
    body: body && JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}: ${await response.text()}`);
  const json = (await response.json()) as { errors?: unknown[] };
  if (json.errors) throw new Error(`GitHub returned errors: ${JSON.stringify(json.errors)}`);
  return json as ResponseBody;
}
