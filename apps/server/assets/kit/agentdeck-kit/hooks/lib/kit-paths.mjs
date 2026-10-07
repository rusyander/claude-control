// Where the kit's hooks live and keep state, and what CLI is calling them.
//
// Self-contained on purpose: the kit is copied per run into the panel's data dir, so every path is
// resolved from THIS file, never from a home-dir config tree. State (stamps, per-session prompt,
// refusal log) goes to the OS temp dir: a hook never writes into the user's config, the kit copy or
// the project outside its `.agent/`.
//
// One kit, several CLIs. Claude Code sends `Bash`/`Write`/`Edit`; Qwen Code sends runtime ids
// (`run_shell_command`, `write_file`, `edit`, `read_file`, `grep_search`, `todo_write`, `agent`);
// Codex sends `Bash` and `apply_patch` (the patch text in `tool_input.command`). `normalize` turns
// each into the Claude shape the guard modules were written against, so a module never branches on
// the CLI. `AGENTDECK_KIT_CLI` (claude|qwen|codex) overrides detection.
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The kit root: `<kit>/hooks/lib/` → `<kit>/`. */
export const KIT_ROOT = resolve(HERE, '..', '..');
/** Situational rules, shared with the skill of the same name (CLIs without hooks load it by hand). */
export const RULES_DIR = join(KIT_ROOT, 'skills', 'situational-rules', 'references');
/** Every stamp, cache and per-session file the hooks keep. Override: AGENTDECK_KIT_STATE. */
export const STATE_DIR = process.env.AGENTDECK_KIT_STATE || join(tmpdir(), 'agentdeck-kit-state');

/** `STATE_DIR/<sub>`, created on first use; null when the temp dir is not writable. */
export function stateDir(sub = '') {
  const dir = sub ? join(STATE_DIR, sub) : STATE_DIR;
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

/** File-name-safe session id ('' when the CLI sent none). */
export const sessionKey = (input) => String(input?.session_id ?? '').replace(/[^a-zA-Z0-9-]/g, '');

/** Which CLI sent this hook input. */
export function cliOf(input) {
  const forced = String(process.env.AGENTDECK_KIT_CLI ?? '').toLowerCase();
  if (forced === 'claude' || forced === 'qwen' || forced === 'codex') return forced;
  const tool = String(input?.tool_name ?? '');
  if (input?.turn_id !== undefined || tool === 'apply_patch') return 'codex';
  if (/^[a-z]+(?:_[a-z]+)+$/.test(tool) || /^(edit|glob|agent|skill)$/.test(tool)) return 'qwen';
  return 'claude';
}

const QWEN_TOOLS = {
  run_shell_command: 'Bash',
  shell: 'Bash',
  write_file: 'Write',
  edit: 'Edit',
  replace: 'Edit',
  read_file: 'Read',
  read_many_files: 'Read',
  grep_search: 'Grep',
  search_file_content: 'Grep',
  glob: 'Glob',
  todo_write: 'TodoWrite',
  agent: 'Agent',
  task: 'Agent',
};

/** Files an `apply_patch` touches, each with the text it adds — one Write/Edit-shaped call per file. */
function patchCalls(patch) {
  const out = [];
  let cur = null;
  for (const line of String(patch ?? '').split('\n')) {
    const m = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (m) {
      cur = { op: m[1], file: m[2].trim(), added: [], removed: [] };
      out.push(cur);
    } else if (cur && line.startsWith('+')) cur.added.push(line.slice(1));
    else if (cur && line.startsWith('-')) cur.removed.push(line.slice(1));
  }
  return out;
}

/**
 * Hook input in Claude's shape. Returns an ARRAY: an `apply_patch` over three files is three calls,
 * each judged on its own; every other input is one. Fields the modules read are filled in; the rest
 * of the original input rides along untouched.
 */
export function normalize(input) {
  if (!input || typeof input !== 'object') return [input];
  const cli = cliOf(input);
  const tool = String(input.tool_name ?? '');
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  if (cli === 'qwen' && QWEN_TOOLS[tool]) {
    const name = QWEN_TOOLS[tool];
    const file = ti.file_path ?? ti.absolute_path ?? ti.absolutePath ?? ti.path;
    const tool_input = {
      ...ti,
      ...(file !== undefined && name !== 'Grep' && name !== 'Glob' ? { file_path: file } : {}),
    };
    if (name === 'Agent' && ti.prompt === undefined && ti.task !== undefined)
      tool_input.prompt = ti.task;
    return [{ ...input, tool_name: name, tool_input, agentdeck_cli: cli }];
  }
  if (cli === 'codex' && tool === 'apply_patch') {
    const calls = patchCalls(ti.command ?? ti.patch ?? ti.input);
    if (!calls.length) return [{ ...input, agentdeck_cli: cli }];
    return calls.map((c) => ({
      ...input,
      tool_name: c.op === 'Add' ? 'Write' : 'Edit',
      tool_input:
        c.op === 'Add'
          ? { file_path: c.file, content: c.added.join('\n') }
          : {
              file_path: c.file,
              old_string: c.removed.join('\n'),
              new_string: c.added.join('\n'),
              patch: true,
            },
      agentdeck_cli: cli,
    }));
  }
  return [{ ...input, agentdeck_cli: cli }];
}

// ---- Per-session log: the consent gate's memory on CLIs whose transcript the kit cannot read -----
// Claude's transcript tells the gate whether the user spoke after a refusal (door B). Qwen and Codex
// keep transcripts in their own formats, so the kit records the two facts it needs itself: each
// prompt the user typed (UserPromptSubmit) and each refusal a guard issued. Week-old logs are swept.

const WEEK = 7 * 864e5;

function logPath(input) {
  const key = sessionKey(input);
  const dir = key && stateDir('sessions');
  return dir ? join(dir, `${key}.jsonl`) : null;
}

/** Append one `{kind:'prompt'|'refusal', ...}` event; never throws. */
export function logSessionEvent(input, event) {
  const file = logPath(input);
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify({ ts: Date.now(), ...event })}\n`, 'utf8');
  } catch {
    /* a log that cannot be written only weakens door B */
  }
}

/** The session's events, oldest first; [] when nothing was recorded. */
export function sessionEvents(input) {
  const file = logPath(input);
  if (!file) return [];
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Drop state files older than a week from one state subfolder. */
export function sweepState(sub) {
  const dir = stateDir(sub);
  if (!dir) return;
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try {
        if (Date.now() - statSync(p).mtimeMs > WEEK) unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}
