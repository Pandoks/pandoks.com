import { appendFile, readFile } from 'node:fs/promises';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

type PullRequestEvent = {
  pull_request: { number: number; head: { sha: string } };
  repository: { url: string };
};

const {
  GITHUB_EVENT_PATH: eventPath,
  GITHUB_STEP_SUMMARY: summaryPath,
  GH_TOKEN: token
} = process.env;
const { pull_request: pullRequest, repository } = JSON.parse(
  await readFile(eventPath!, 'utf8')
) as PullRequestEvent;
const pr = pullRequest.number;
const agentsMd = await readFile('scripts/claude-review/AGENTS.md', 'utf8');
const model = 'claude-opus-5-5';
const effort = 'xhigh';
const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28'
};
const posted: { id: number; body: string }[] = [];

// NOTE: Same name and inputs as claude-code-action's tool, which /code-review --comment looks for.
const inlineComment = tool(
  'create_inline_comment',
  'Create an inline comment on a specific line or lines in a PR file',
  {
    path: z.string().describe("The file path to comment on (e.g., 'src/index.js')"),
    body: z
      .string()
      .describe(
        'The comment text (supports markdown and GitHub code suggestion blocks). A suggestion block replaces the entire line range.'
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
    if (startLine !== undefined && startLine >= line) {
      return {
        content: [
          { type: 'text', text: `startLine (${startLine}) must be less than line (${line})` }
        ],
        isError: true
      };
    }
    const response = await fetch(`${repository.url}/pulls/${pr}/comments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        body,
        commit_id: pullRequest.head.sha,
        path,
        line,
        side,
        ...(startLine === undefined ? {} : { start_line: startLine, start_side: side })
      })
    });
    if (!response.ok) {
      return {
        content: [
          { type: 'text', text: `GitHub returned ${response.status}: ${await response.text()}` }
        ],
        isError: true
      };
    }
    const comment = (await response.json()) as { id: number; html_url: string };
    posted.push({ id: comment.id, body });
    return { content: [{ type: 'text', text: `Posted ${comment.html_url}` }] };
  }
);

const subagents = new Map<string, { model?: string; effort: string }>();
let result;
for await (const message of query({
  prompt: `/code-review xhigh --comment ${pr}`,
  options: {
    model,
    effort,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: agentsMd },
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
    const parent = message.parent_tool_use_id
      ? subagents.get(message.parent_tool_use_id)
      : undefined;
    if (parent) parent.model = message.message.model;
    for (const block of message.message.content) {
      if (block.type === 'tool_use' && block.name === 'Agent') {
        // NOTE: A subagent without an effort runs at its parent's.
        const input = block.input as { effort?: string };
        subagents.set(block.id, { effort: input.effort ?? parent?.effort ?? effort });
      }
    }
  }
  if (message.type === 'result') result = message;
}

const label = (id: string, level: string) => {
  const [, family, major, minor] = /^claude-(\w+)-(\d+)-(\d+)/.exec(id)!;
  return `${family[0].toUpperCase()}${family.slice(1)} ${major}.${minor} ${level}`;
};
const counts = new Map<string, number>();
for (const subagent of subagents.values()) {
  if (!subagent.model) continue;
  const key = label(subagent.model, subagent.effort);
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
const footer =
  `\n\n---\n${label(model, effort)}` +
  (counts.size
    ? ` managing subagents:\n${[...counts].map(([key, count]) => `- ${count}x ${key}`).join('\n')}`
    : '');
// NOTE: Comments get the footer after the run, so it counts subagents started after they posted.
for (const { id, body } of posted) {
  const response = await fetch(`${repository.url}/pulls/comments/${id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ body: body + footer })
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}: ${await response.text()}`);
}

console.log(JSON.stringify(result, null, 2));
if (result) {
  await appendFile(
    summaryPath!,
    `## Claude review\n\n${result.subtype === 'success' ? result.result : result.subtype}${footer}\n\n` +
      `$${result.total_cost_usd.toFixed(2)}, ${result.num_turns} turns, ${Math.round(result.duration_ms / 1000)}s\n`
  );
}
if (!result || result.is_error || result.subtype !== 'success' || !result.total_cost_usd) {
  process.exit(1);
}
