// PreToolUse(forge MCP discover_tools), split group only (AGENTDECK_SPLIT_CHILD=1): a group activates
// only the forge tool categories its delivery uses.
//
// g5 25.10 (MR !1101): blocked from polling the pipeline, the group called
// discover_tools {"category":"merge_requests"} looking for a way around — 29 tools landed in the window
// (merge, approve, delete note, rebase), none was used, and the ~5 KB delta was re-billed on every later
// request until a resume dropped it. A group needs no issues, labels, wiki, releases, variables or raw
// API tools to deliver an MR, and every activated category stays in the window for the rest of the turn.
//
// Allowed: listing (no category) and the two categories delivery needs —
//   · merge_requests: thread replies (create_merge_request_discussion_note) live there, and
//     review-publish-guard sends the model to them; merging itself stays under the run profile's deny
//     (merge_merge_request, F-13), so activating the category does not hand a group the merge;
//   · pipelines: the failed job's log (get_pipeline_job_output) is the first step on a red pipeline.
// Everything else is refused, naming the categories that are allowed. An allowlist, not a denylist: a
// category a future server version adds is refused until someone decides a group needs it.
// Claude form `mcp__<server>__discover_tools`; opencode form `<server>_discover_tools`.
import { deny } from './transcript.mjs';

export const DISCOVER = /^(?:mcp__[^_]*gitlab[^_]*__|[\w-]*gitlab[\w-]*_)discover_tools$/i;
const ALLOWED = new Set(['merge_requests', 'pipelines']);

const splitChild = () => process.env.AGENTDECK_SPLIT_CHILD === '1';

/** The categories one call asks for: `category` as a string or a list, comma-separated allowed. */
function categories(input) {
  const raw = input?.category ?? input?.categories;
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return list
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export default function forgeToolsetGuard(input) {
  if (!splitChild()) return null;
  if (!DISCOVER.test(String(input?.tool_name ?? ''))) return null;
  const extra = categories(input?.tool_input).filter((category) => !ALLOWED.has(category));
  if (extra.length === 0) return null;
  return deny(
    `forge-toolset-guard A split group activates only the forge categories delivery uses: ${[...ALLOWED].join(', ')}. ` +
      `Refused: ${extra.join(', ')} — every activated category is re-sent on each later request of the turn. ` +
      'The core tools and those two categories cover the MR, its threads and the pipeline job logs; ' +
      'what they cannot do is a step for the human — name it in your answer.',
  );
}
