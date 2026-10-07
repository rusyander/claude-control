// Review agents spawn unasked: a one-question grant per review still kept the user at the screen
// before every review, and a review fleet is sized by the skill's plan, not by a dialog.
// A spawn passes when its `description` carries a review tag and it runs on `lane-high` (a reviewer is
// never weaker than the author); 40 per session, the 41st gets spawn-cost-guard's ordinary dialog —
// a backstop against a runaway loop, not a budget. Any failure → false → the dialog.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, sessionKey } from './kit-paths.mjs';

const TAG = /^(?:deep-review\s+(?:r\d+|verify)\b|review:)/i;
/** The kit's own agent, bare or plugin-namespaced. */
const LANE_HIGH = /^(?:agentdeck-kit:)?lane-high$/;
const CAP = 40;

/** True = a tagged lane-high review spawn inside the session cap; it is counted. */
export function reviewSpawnAllows(input, arg) {
  try {
    const session = sessionKey(input).slice(0, 12);
    if (!session || !TAG.test(String(arg?.description ?? '').trim())) return false;
    if (!LANE_HIGH.test(String(arg?.subagent_type ?? ''))) return false;
    const dir = stateDir('stamps');
    if (!dir) return false;
    const file = join(dir, `review-spawns-${session}.txt`);
    let used = 0;
    try {
      used = Number(readFileSync(file, 'utf8')) || 0;
    } catch {
      /* first spawn of the session */
    }
    if (used >= CAP) return false;
    writeFileSync(file, String(used + 1));
    return true;
  } catch {
    return false;
  }
}
