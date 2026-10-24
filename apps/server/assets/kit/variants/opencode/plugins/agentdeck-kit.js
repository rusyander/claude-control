// agentdeck kit for OpenCode — a plugin shim over the kit's hook dispatcher (`hooks/lib/run.mjs`).
//
// OpenCode has no command hooks: a plugin's `tool.execute.before` throwing is what refuses a call
// (docs: opencode.ai/docs/plugins). So every call is handed to the dispatcher in Claude's hook shape
// with `--cli=opencode`; a deny comes back as `hookSpecificOutput.permissionDecision` and is thrown with
// its reason. `tool.execute.after` feeds the post half (learned command durations) and appends any text
// it returns to the tool result the model reads. `chat.message` records the user's prompt — the turn
// boundary and the consent gates' «the user answered» read it from the kit's session log.
// No Stop: `session.idle` is an event and cannot hold a finished turn.
//
// Install: copy this file into `~/.config/opencode/plugins/` (or a project's `.opencode/plugins/`) and
// set AGENTDECK_KIT_DIR to a kit copy. Never point OPENCODE_CONFIG_DIR at the kit itself: OpenCode then
// reads the kit's Claude-format `agents/*.md` as its own agents and refuses to start (opencode 1.18.35).
// Without AGENTDECK_KIT_DIR the kit is looked for one level up (the shim left inside `<kit>/plugins/`).
// `node` must be on PATH (AGENTDECK_KIT_NODE overrides).
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
// Runtime globals (Bun under OpenCode, Node in the tests) — the plugin stays as the live check ran it.
/* global process, setTimeout, clearTimeout */
import { fileURLToPath } from 'node:url';

const KIT = resolve(
  process.env.AGENTDECK_KIT_DIR || join(dirname(fileURLToPath(import.meta.url)), '..'),
);
const RUN = join(KIT, 'hooks', 'lib', 'run.mjs');
const NODE = process.env.AGENTDECK_KIT_NODE || 'node';
const TIMEOUT_MS = 30_000;

/** One dispatcher run; its parsed stdout, or null on silence, a crash or a timeout (fail open). */
function dispatch(event, payload) {
  return new Promise((done) => {
    let out = '';
    let child;
    try {
      child = spawn(NODE, [RUN, event, '--cli=opencode'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      return done(null);
    }
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', () => {
      clearTimeout(timer);
      done(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        done(out.trim() ? JSON.parse(out) : null);
      } catch {
        done(null);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

const textOf = (parts) =>
  (Array.isArray(parts) ? parts : [])
    .filter((p) => p?.type === 'text' && typeof p.text === 'string' && !p.synthetic)
    .map((p) => p.text)
    .join('\n');

export const AgentdeckKit = async ({ directory }) => ({
  'chat.message': async (input, output) => {
    const prompt = textOf(output?.parts);
    if (!prompt.trim()) return;
    await dispatch('prompt', {
      hook_event_name: 'UserPromptSubmit',
      session_id: input?.sessionID,
      cwd: directory,
      prompt,
    });
  },
  'tool.execute.before': async (input, output) => {
    const verdict = await dispatch('pre', {
      hook_event_name: 'PreToolUse',
      session_id: input?.sessionID,
      cwd: directory,
      tool_name: input?.tool,
      tool_input: output?.args ?? {},
      tool_use_id: input?.callID,
    });
    const h = verdict?.hookSpecificOutput;
    if (h?.permissionDecision === 'deny')
      throw new Error(String(h.permissionDecisionReason || 'agentdeck kit: refused'));
  },
  'tool.execute.after': async (input, output) => {
    const res = await dispatch('post-any', {
      hook_event_name: 'PostToolUse',
      session_id: input?.sessionID,
      cwd: directory,
      tool_name: input?.tool,
      tool_input: input?.args ?? {},
      tool_use_id: input?.callID,
      tool_response: output?.output,
    });
    const text = res?.hookSpecificOutput?.additionalContext;
    if (text && output && typeof output.output === 'string') output.output += `\n\n${text}`;
  },
});
