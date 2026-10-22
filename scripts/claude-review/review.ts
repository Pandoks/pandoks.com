import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

type PullRequestEvent = {
  pull_request: { number: number; base: { sha: string }; head: { sha: string } };
  repository: { url: string };
};

const {
  GITHUB_EVENT_PATH: eventPath = '',
  GITHUB_STEP_SUMMARY: summaryPath = '',
  GITHUB_WORKSPACE: cwd,
  GH_TOKEN: token
} = process.env;
const { pull_request: pullRequest, repository } = JSON.parse(
  await readFile(eventPath, 'utf8')
) as PullRequestEvent;
const pr = pullRequest.number;
// NOTE: From the base branch, so a PR can't rewrite its own review rules.
const agentsMd = execFileSync('git', ['show', `${pullRequest.base.sha}:AGENTS.md`], {
  cwd,
  encoding: 'utf8'
});

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
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        body,
        commit_id: pullRequest.head.sha,
        path,
        line,
        side,
        ...(startLine === undefined ? {} : { start_line: startLine, start_side: side })
      })
    });
    const text = response.ok
      ? `Posted ${((await response.json()) as { html_url: string }).html_url}`
      : `GitHub returned ${response.status}: ${await response.text()}`;
    return { content: [{ type: 'text', text }], isError: !response.ok };
  }
);

let result;
for await (const message of query({
  prompt: `/code-review --comment ${pr}`,
  options: {
    cwd,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: agentsMd },
    tools: { type: 'preset', preset: 'claude_code' },
    // NOTE: No setting sources or other MCP servers, so a PR can't add hooks, permissions, skills,
    // or servers through .claude/ or .mcp.json.
    settingSources: [],
    strictMcpConfig: true,
    maxBudgetUsd: 5,
    mcpServers: {
      github_inline_comment: createSdkMcpServer({
        name: 'github_inline_comment',
        tools: [inlineComment]
      })
    },
    allowedTools: [
      'Agent',
      'Read',
      'Grep',
      'Glob',
      'mcp__github_inline_comment__create_inline_comment',
      `Bash(gh pr diff ${pr}:*)`,
      `Bash(gh pr view ${pr}:*)`,
      `Bash(gh pr comment ${pr}:*)`,
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git show:*)'
    ]
  }
})) {
  if (message.type === 'result') result = message;
}

console.log(JSON.stringify(result, null, 2));
if (result) {
  await appendFile(
    summaryPath,
    `## Claude review\n\n${result.subtype === 'success' ? result.result : result.subtype}\n\n` +
      `$${result.total_cost_usd.toFixed(2)}, ${result.num_turns} turns, ${Math.round(result.duration_ms / 1000)}s\n`
  );
}
if (!result || result.is_error || result.subtype !== 'success' || !result.total_cost_usd) {
  process.exit(1);
}
