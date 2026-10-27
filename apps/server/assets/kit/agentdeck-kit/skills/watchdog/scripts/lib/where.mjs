// Which layer this copy of the watch scripts runs from. The same files ship twice: in a personal layer
// (<config>/skills/watchdog/…) and in the panel kit (<kit>/skills/watchdog/…, composed per run by the panel).
// Kit-side state (the keepalive registry, the review-spawn counter) lives where the kit's own hooks keep theirs —
// `AGENTDECK_KIT_STATE` or <os temp>/agentdeck-kit-state (kit hooks/lib/kit-paths.mjs STATE_DIR) — never in the
// user's config. A Bash call inherits the session's env, so the script and the kit hook resolve the same dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** <root>/skills/watchdog/scripts/lib → <root>. */
const ROOT = path.resolve(HERE, '..', '..', '..', '..');

/** The kit root when this copy sits in a kit (its hooks' path module beside the skills), else null. */
export const kitRoot = (root = ROOT) => (fs.existsSync(path.join(root, 'hooks', 'lib', 'kit-paths.mjs')) ? root : null);

/** The kit hooks' state dir — the same rule as kit-paths.mjs STATE_DIR. */
export const kitStateDir = (env = process.env) => env.AGENTDECK_KIT_STATE || path.join(os.tmpdir(), 'agentdeck-kit-state');
