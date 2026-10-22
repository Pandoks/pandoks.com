import { query } from '@anthropic-ai/claude-agent-sdk';

const { GITHUB_REPOSITORY: repo, GITHUB_WORKSPACE: cwd, PR_NUMBER: pr } = process.env;

let result;
for await (const message of query({
  prompt: `/code-review --comment ${pr}`,
  options: {
    cwd,
    // NOTE: No setting sources, so a PR can't add hooks or permissions through .claude/.
    settingSources: [],
    allowedTools: [
      'Read',
      'Grep',
      'Glob',
      'Write(//tmp/**)',
      `Bash(gh pr diff ${pr}:*)`,
      `Bash(gh pr view ${pr}:*)`,
      `Bash(gh pr comment ${pr}:*)`,
      `Bash(gh api repos/${repo}/pulls/${pr}/comments:*)`
    ]
  }
})) {
  if (message.type === 'result') result = message;
}

console.log(JSON.stringify(result, null, 2));
if (!result || result.is_error || result.subtype !== 'success' || !result.total_cost_usd) {
  process.exit(1);
}
