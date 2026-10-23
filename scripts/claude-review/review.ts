import { appendFile, readFile } from 'node:fs/promises';
import {
  createSdkMcpServer,
  query,
  tool,
  type SDKResultMessage
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

type PullRequestEvent = {
  pull_request: { number: number; head: { sha: string } };
  repository: { url: string; name: string; owner: { login: string } };
};

const MODEL = 'claude-opus-5-5';
const EFFORT = 'xhigh';

const event = JSON.parse(
  await readFile(process.env.GITHUB_EVENT_PATH!, 'utf8')
) as PullRequestEvent;
const pullUrl = `${event.repository.url}/pulls/${event.pull_request.number}`;
const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${process.env.GH_TOKEN!}`,
  'X-GitHub-Api-Version': '2022-11-28'
};

async function requestGithub<ResponseBody>({
  method,
  url,
  body
}: {
  method: string;
  url: string;
  body?: object;
}) {
  const response = await fetch(url, { method, headers, body: body && JSON.stringify(body) });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}: ${await response.text()}`);
  const json = (await response.json()) as { errors?: unknown[] };
  if (json.errors) throw new Error(`GitHub returned errors: ${JSON.stringify(json.errors)}`);
  return json as ResponseBody;
}

function formatModelLabel({ model, effort }: { model: string; effort: string }) {
  const [, family, major, minor] = /^claude-(\w+)-(\d+)-(\d+)/.exec(model)!;
  return `${family[0].toUpperCase()}${family.slice(1)} ${major}.${minor} ${effort}`;
}

// NOTE: A runner that dies before the cleanup step leaves the token's pending review behind, and
// GitHub allows one per user per PR.
const pendingReviews = await requestGithub<{
  data: { repository: { pullRequest: { reviews: { nodes: { fullDatabaseId: string }[] } } } };
}>({
  method: 'POST',
  url: process.env.GITHUB_GRAPHQL_URL!,
  body: {
    query:
      'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviews(states: [PENDING], first: 1) { nodes { fullDatabaseId } } } } }',
    variables: {
      owner: event.repository.owner.login,
      name: event.repository.name,
      number: event.pull_request.number
    }
  }
});
const pendingReview = pendingReviews.data.repository.pullRequest.reviews.nodes[0];
if (pendingReview) {
  await requestGithub({
    method: 'DELETE',
    url: `${pullUrl}/reviews/${pendingReview.fullDatabaseId}`
  });
}

const review = await requestGithub<{ id: number; node_id: string }>({
  method: 'POST',
  url: `${pullUrl}/reviews`,
  body: { commit_id: event.pull_request.head.sha }
});

let commentCalls = 0;
let commentsAdded = 0;

// NOTE: Same name and inputs as claude-code-action's tool, which /code-review --comment looks for.
const inlineComment = tool(
  'create_inline_comment',
  'Create an inline comment on a specific line or lines in a PR file',
  {
    path: z.string().describe("The file path to comment on (e.g., 'src/index.js')"),
    body: z
      .string()
      .describe(
        'The comment text (supports markdown and GitHub code suggestion blocks). ' +
          'For code suggestions, use: ```suggestion\\nreplacement code\\n```. ' +
          'IMPORTANT: The suggestion block will REPLACE the ENTIRE line range (single line or startLine to line). ' +
          'Ensure the replacement is syntactically complete and valid - it must work as a drop-in replacement for the selected lines.'
      ),
    line: z
      .number()
      .int()
      .positive()
      .describe('Line number, or the end line of a multi-line comment'),
    startLine: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Start line for multi-line comments'),
    side: z
      .enum(['LEFT', 'RIGHT'])
      .default('RIGHT')
      .describe('LEFT for old code, RIGHT for new code')
  },
  async ({ path, body, line, startLine, side }) => {
    const { data } = await requestGithub<{
      data: { addPullRequestReviewThread: { thread: { id: string } | null } };
    }>({
      method: 'POST',
      url: process.env.GITHUB_GRAPHQL_URL!,
      body: {
        query:
          'mutation($input: AddPullRequestReviewThreadInput!) { addPullRequestReviewThread(input: $input) { thread { id } } }',
        variables: {
          input: {
            pullRequestReviewId: review.node_id,
            path,
            body,
            line,
            side,
            ...(startLine === undefined ? {} : { startLine, startSide: side })
          }
        }
      }
    });
    // NOTE: GitHub returns a null thread without errors for some lines it can't comment on.
    if (!data.addPullRequestReviewThread.thread) {
      throw new Error(`GitHub added no comment: ${JSON.stringify(data)}`);
    }
    commentsAdded++;
    return { content: [{ type: 'text', text: 'Added the comment to the pending review' }] };
  }
);

const subagentModels: Record<string, string> = {};
const agentCalls: Record<string, { effort?: string; parentId: string | null }> = {};

// NOTE: A subagent without an effort runs at its parent's.
function resolveEffort({ toolUseId }: { toolUseId: string | null }): string {
  const call = toolUseId ? agentCalls[toolUseId] : undefined;
  return call ? (call.effort ?? resolveEffort({ toolUseId: call.parentId })) : EFFORT;
}

let reviewFailed = false;
let result: SDKResultMessage | undefined;
try {
  for await (const message of query({
    prompt: `/code-review xhigh --comment ${event.pull_request.number}`,
    options: {
      model: MODEL,
      effort: EFFORT,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      forwardSubagentText: true,
      mcpServers: {
        github_inline_comment: createSdkMcpServer({
          name: 'github_inline_comment',
          tools: [inlineComment]
        })
      }
    }
  })) {
    if (message.type === 'assistant') {
      const parentId = message.parent_tool_use_id;
      // NOTE: Background tasks are disabled, but a subagent continued with SendMessage still runs in
      // the background, so its messages can arrive before its Agent call.
      if (parentId && message.message.model !== '<synthetic>') {
        subagentModels[parentId] ??= message.message.model;
      }
      for (const block of message.message.content) {
        if (block.type !== 'tool_use') continue;
        if (block.name === 'Agent') {
          agentCalls[block.id] = { effort: (block.input as { effort?: string }).effort, parentId };
        }
        // NOTE: The SDK rejects calls whose input fails the schema before the handler runs.
        if (block.name === 'mcp__github_inline_comment__create_inline_comment') commentCalls++;
      }
    }
    // NOTE: The forked /code-review is the task without a tool_use_id, and its failure still ends
    // in a success result.
    if (
      message.type === 'system' &&
      message.subtype === 'task_notification' &&
      !message.tool_use_id &&
      message.status === 'failed'
    ) {
      reviewFailed = true;
    }
    if (message.type === 'result') {
      result = message;
      break;
    }
  }
} finally {
  const counts = new Map<string, number>();
  for (const id of Object.keys(agentCalls)) {
    const model = subagentModels[id];
    if (!model) continue;
    const label = formatModelLabel({ model, effort: resolveEffort({ toolUseId: id }) });
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const footer =
    `\n\n---\n${formatModelLabel({ model: MODEL, effort: EFFORT })}` +
    (counts.size
      ? ` managing subagents:\n${[...counts].map(([label, count]) => `- ${count}x ${label}`).join('\n')}`
      : '');
  const text = result?.subtype === 'success' ? result.result : (result?.subtype ?? 'No result');

  console.log(JSON.stringify(result, null, 2));
  if (result) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY!,
      `## Claude review\n\n${text}${footer}\n\n` +
        `$${result.total_cost_usd.toFixed(2)}, ${Math.round(result.duration_ms / 1000)}s, ` +
        `${commentCalls - commentsAdded} of ${commentCalls} inline comment calls failed\n`
    );
  }
  await requestGithub({
    method: 'POST',
    url: `${pullUrl}/reviews/${review.id}/events`,
    body: { event: 'COMMENT', body: text + footer }
  });
}

if (
  reviewFailed ||
  (commentCalls && !commentsAdded) ||
  !result ||
  result.is_error ||
  result.subtype !== 'success' ||
  !result.total_cost_usd
) {
  process.exit(1);
}
