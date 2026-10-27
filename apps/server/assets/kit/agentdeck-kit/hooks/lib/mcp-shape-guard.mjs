// A jmespath that cannot match the result's shape is refused before the call (26.10.2026).
//
// `mr_discussions` of the GitLab MCP returns `{"items":[…],"pagination":{…}}`. A filter written for a bare
// array (`[?notes[?resolvable && !resolved]]…`) yields `null` — the call spends a forge round trip and a
// turn, and the retry follows. mcp-protocol item 12 names the shape, but the rule block rides in with the
// FIRST forge call, after that call's arguments were already written: agentgw 25.10 (2 nulls) and g0 26.10
// (1 null) both missed it. An expression that names neither `items` nor `pagination` reads nothing.
import { deny } from './transcript.mjs';

/** Claude/Qwen form `mcp__<server>__mr_discussions` and opencode's `<server>_mr_discussions`. */
export const WRAPPED = /^(?:mcp__[^_]*gitlab[^_]*__|[\w-]*gitlab[\w-]*_)mr_discussions$/i;
const NAMES_FIELD = /(?<![\w$])(items|pagination)(?![\w$])/;

/** @returns {null | {decision:'deny', reason:string}} */
export default function mcpShapeGuard(input) {
  if (!WRAPPED.test(String(input?.tool_name ?? ''))) return null;
  const expr = input?.tool_input?.jmespath;
  if (typeof expr !== 'string' || !expr.trim() || NAMES_FIELD.test(expr)) return null;
  return deny(
    `mcp-shape-guard: mr_discussions returns {"items":[…],"pagination":{…}} — this jmespath names neither field ` +
      `and returns null. Start it at items, e.g. \`items[?notes[?resolvable && !resolved]]\`.`,
  );
}
