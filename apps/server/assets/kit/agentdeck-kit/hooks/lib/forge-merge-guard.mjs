// forge-merge-guard — merging an MR/PR is the user's to run, with no door. git-guard already refuses
// a local `git merge`; the merge of a REVIEWED request went through untouched: `gh pr merge`,
// `glab mr merge`, the REST call (`PUT …/merge_requests/<n>/merge`, `PUT …/pulls/<n>/merge`) and the
// forge MCP tools (`merge_merge_request`, `accept_merge_request`, `merge_pull_request`). Under the
// panel's permission broker those reach a card; under full access nothing stopped them at all.
//
// CLI forms are matched outside quotes (a commit message that mentions `gh pr merge` is text, not a
// call); the REST form keeps its quotes, because the URL usually sits inside them, and needs PUT —
// `GET …/pulls/<n>/merge` only asks whether it was merged.
//
// The SAME file lives in the panel kit (assets/kit/agentdeck-kit/hooks/lib/) and in ~/.claude/hooks/lib/;
// `tools/kit-twins.mjs` in the agentdeck repo turns the build red when the two drift.

const CLI_MERGE = /(?:^|[\s;&|(])(?:gh\s+pr\s+merge|glab\s+mr\s+(?:merge|accept))\b/;
const API_MERGE = /\/(?:merge_requests|pulls)\/\d+\/merge(?![\w-])/;
const PUT = /(?:-X\s*|--request[\s=]+|--method[\s=]+|-Method\s+)['"]?PUT\b/i;
const API_CLIENT =
  /\b(?:curl|wget|http|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|gh\s+api|glab\s+api)\b/i;
// Claude/Qwen form `mcp__<server>__<tool>` and opencode's `<server>_<tool>` (26.10: the opencode form
// passed untouched).
const MCP_MERGE =
  /(?:^|_)(?:merge_merge_request|accept_merge_request|merge_pull_request|merge_pr|merge_mr)$/i;
// Approving one's own request inside a task step is the core permit's refusal (platform step), not this
// guard's: outside the core the user may ask for an approval.

const unquoted = (command) => command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');

const refuse = (what) => ({
  decision: 'deny',
  reason:
    `[forge-merge-guard] ${what} merges a request — merging is the user's to run, no consent opens it. ` +
    'Say the MR/PR is ready (link, state of its checks) and stop.',
});

export default function forgeMergeGuard(input) {
  const tool = String(input?.tool_name ?? '');
  if (MCP_MERGE.test(tool)) return refuse(`\`${tool}\``);
  if (!/^(?:Bash|PowerShell)$/.test(tool)) return null;
  const command = String(input?.tool_input?.command ?? '');
  if (CLI_MERGE.test(unquoted(command))) return refuse('This command');
  if (API_MERGE.test(command) && PUT.test(command) && API_CLIENT.test(command))
    return refuse('This API call');
  return null;
}
