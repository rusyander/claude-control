// PostToolUse (MCP), split group only (AGENTDECK_SPLIT_CHILD=1): the forge's echo of an MR write is cut
// to the fields a next step uses, through `updatedMCPToolOutput` (CLI 2.1.310: "Replaces the output for
// MCP tools only"; kept over `updatedToolOutput` because older builds know only this one).
//
// Fleet g1 (25.10.2026): 6× update_merge_request carried 91k of input and 62k of echo — the forge sends
// the whole description back, which is the text the agent itself just wrote (it stays in the call's
// input, in the transcript). Kept: id, iid, url, branches, state, sha, merge status, timestamps, and the
// description's length; `get_merge_request` still returns the whole MR. An error result is never cut.
const MR_WRITE = /^mcp__.+__(update_merge_request|create_merge_request)$/;
export const ECHO_MIN = 1500;
const KEEP = [
  'id',
  'iid',
  'project_id',
  'title',
  'state',
  'draft',
  'web_url',
  'source_branch',
  'target_branch',
  'sha',
  'merge_status',
  'detailed_merge_status',
  'has_conflicts',
  'created_at',
  'updated_at',
];

const splitChild = () => process.env.AGENTDECK_SPLIT_CHILD === '1';

/** The short form of one echoed MR (a JSON text), or null when the text is not an MR echo. */
export function trimEcho(text) {
  if (typeof text !== 'string' || text.length < ECHO_MIN) return null;
  let mr;
  try {
    mr = JSON.parse(text);
  } catch {
    return null;
  }
  if (!mr || typeof mr !== 'object' || Array.isArray(mr) || mr.iid === undefined || !mr.web_url)
    return null;
  const short = {};
  for (const k of KEEP) if (mr[k] !== undefined) short[k] = mr[k];
  if (typeof mr.description === 'string') short.description_chars = mr.description.length;
  short.note =
    'mr-echo-trim: the forge echo is cut — the description is the one this call sent; get_merge_request returns the whole MR.';
  const out = JSON.stringify(short);
  return out.length < text.length ? out : null;
}

/** The same shape the tool returned, its MR echo cut; null = leave the output alone. */
function trimShape(response) {
  if (typeof response === 'string') return trimEcho(response);
  if (Array.isArray(response)) {
    let changed = false;
    const blocks = response.map((b) => {
      const t = b?.type === 'text' ? trimEcho(b.text) : null;
      if (!t) return b;
      changed = true;
      return { ...b, text: t };
    });
    return changed ? blocks : null;
  }
  if (response && typeof response === 'object') {
    if (response.isError === true || response.is_error === true) return null;
    if (Array.isArray(response.content)) {
      const content = trimShape(response.content);
      return content ? { ...response, content } : null;
    }
    if (response.iid !== undefined) {
      const t = trimEcho(JSON.stringify(response));
      return t ? JSON.parse(t) : null;
    }
  }
  return null;
}

/** @returns the replacement output for `updatedMCPToolOutput`, or null. */
export default function mrEchoTrim(input) {
  if (!splitChild() || !MR_WRITE.test(String(input?.tool_name ?? ''))) return null;
  return trimShape(input?.tool_response);
}
