import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const {
  GITHUB_REPOSITORY: repo,
  GITHUB_WORKSPACE: cwd,
  GH_TOKEN: token,
  HEAD_SHA: headSha,
  PR_NUMBER: pr
} = process.env;

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
    const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}/comments`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        body,
        commit_id: headSha,
        path,
        line,
        side,
        ...(startLine && startLine < line ? { start_line: startLine, start_side: side } : {})
      })
    });
    const text = response.ok
      ? `Posted ${(await response.json()).html_url}`
      : `GitHub returned ${response.status}: ${await response.text()}`;
    return { content: [{ type: 'text', text }], isError: !response.ok };
  }
);

let result;
for await (const message of query({
  prompt: `/code-review --comment ${pr}`,
  options: {
    cwd,
    // NOTE: No setting sources, so a PR can't add hooks or permissions through .claude/.
    settingSources: [],
    mcpServers: {
      github_inline_comment: createSdkMcpServer({
        name: 'github_inline_comment',
        tools: [inlineComment]
      })
    },
    allowedTools: [
      'Read',
      'Grep',
      'Glob',
      'mcp__github_inline_comment__create_inline_comment',
      `Bash(gh pr diff ${pr}:*)`,
      `Bash(gh pr view ${pr}:*)`,
      `Bash(gh pr comment ${pr}:*)`
    ]
  }
})) {
  if (message.type === 'result') result = message;
}

console.log(JSON.stringify(result, null, 2));
if (!result || result.is_error || result.subtype !== 'success' || !result.total_cost_usd) {
  process.exit(1);
}
