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
// the CLI. Gemini, Goose, Kimi and OpenCode reach the kit only through a hook config installed by
// hand (`variants/<cli>/`); `DIALECT_TOOLS` maps their tool names and inputs the same way.
// `AGENTDECK_KIT_CLI` (any of KIT_CLIS; `run.mjs --cli=<name>` sets it) overrides detection.
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

/**
 * Every CLI the kit answers. The last four reach the kit only through a hook config installed by hand
 * (`variants/<cli>/`), which names its CLI on the command line (`run.mjs <event> --cli=<name>`):
 * Gemini runs hooks in a sanitised env, and an inline `VAR=x cmd` is not portable to Windows shells.
 */
export const KIT_CLIS = ['claude', 'qwen', 'codex', 'gemini', 'goose', 'kimi', 'opencode'];
const known = (v) => (KIT_CLIS.includes(v) ? v : null);

/** Gemini's own event names (hooks reference): only Gemini sends them. */
const GEMINI_EVENTS = new Set(['BeforeTool', 'AfterTool', 'BeforeAgent', 'AfterAgent']);
/** Kimi's tool names no other CLI uses (Glob/Grep/Agent are shared with Claude, so they do not tell). */
const KIMI_ONLY = /^(Shell|WriteFile|StrReplaceFile|ReadFile|SetTodoList)$/;

/** Which CLI sent this hook input. */
export function cliOf(input) {
  const forced = known(String(process.env.AGENTDECK_KIT_CLI ?? '').toLowerCase());
  if (forced) return forced;
  // A call `normalize` already rewrote carries its CLI: a Qwen shell is `Bash` by then.
  const stamped = known(input?.agentdeck_cli);
  if (stamped) return stamped;
  const tool = String(input?.tool_name ?? '');
  if (input?.turn_id !== undefined || tool === 'apply_patch') return 'codex';
  if (GEMINI_EVENTS.has(String(input?.hook_event_name ?? ''))) return 'gemini';
  // Goose names the event `event` and sends no `hook_event_name` (Open Plugins payload).
  if (input?.event !== undefined && input?.hook_event_name === undefined) return 'goose';
  if (KIMI_ONLY.test(tool)) return 'kimi';
  if (/^[a-z]+(?:_[a-z]+)+$/.test(tool) || /^(edit|glob|agent|skill)$/.test(tool)) return 'qwen';
  return 'claude';
}

/**
 * The CLIs whose hook protocol has no «ask»: an ask becomes a deny that tells the model to get the
 * user's yes in chat first (items.mjs). Codex (hooks docs); Gemini — allow/deny/block; Goose — block
 * only; Kimi — «ask» is ignored, i.e. fails open; OpenCode — the plugin can only throw.
 */
export const ASKLESS = new Set(['codex', 'gemini', 'goose', 'kimi', 'opencode']);

/**
 * The shell's background flag as THIS CLI's model must write it, or null where the shell has none:
 * Codex's `Bash` input is `{command}` only (hooks docs), so a «run it in the background» refusal there
 * could never be obeyed. Claude and Kimi (`Shell`): `run_in_background`; Qwen and Gemini
 * (`run_shell_command`): `is_background`; Goose `shell` and OpenCode `bash` have none.
 */
export function backgroundParam(input) {
  const cli = cliOf(input);
  if (cli === 'codex' || cli === 'goose' || cli === 'opencode') return null;
  return cli === 'qwen' || cli === 'gemini' ? 'is_background' : 'run_in_background';
}

/**
 * The shell takes a per-call `timeout` in ms: Claude, Qwen (bundle 0.25) and OpenCode `bash` do.
 * Codex and Gemini have none; Kimi (`timeout`) and Goose (`timeout_secs`) count seconds — advice in ms
 * would be wrong there, so it is not given.
 */
export const hasShellTimeout = (input) => {
  const cli = cliOf(input);
  return cli === 'claude' || cli === 'qwen' || cli === 'opencode';
};

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

/**
 * Tool names of the hand-installed CLIs → Claude's, from each CLI's published tool schema. Gemini is
 * Qwen's upstream: the same snake_case ids (`run_shell_command`, `write_file`, `replace`, …).
 */
const DIALECT_TOOLS = {
  gemini: { ...QWEN_TOOLS, write_todos: 'TodoWrite' },
  // kimi-cli src/kimi_cli/tools: Shell, WriteFile, StrReplaceFile, ReadFile, Grep, Glob, SetTodoList, Agent.
  kimi: {
    Shell: 'Bash',
    WriteFile: 'Write',
    StrReplaceFile: 'Edit',
    ReadFile: 'Read',
    Grep: 'Grep',
    Glob: 'Glob',
    SetTodoList: 'TodoWrite',
    Agent: 'Agent',
  },
  // goose hooks docs, «Tool Input Keys»: the developer extension's tools arrive unprefixed.
  goose: { shell: 'Bash', write: 'Write', edit: 'Edit' },
  opencode: {
    bash: 'Bash',
    write: 'Write',
    edit: 'Edit',
    read: 'Read',
    grep: 'Grep',
    glob: 'Glob',
    todowrite: 'TodoWrite',
    task: 'Agent',
  },
};

/** Gemini, Goose, Kimi, OpenCode: the CLIs that reach the kit only through `variants/<cli>/`. */
export const isHandInstalled = (cli) => Object.hasOwn(DIALECT_TOOLS, cli);

/** Claude's event names for the ones Gemini and Goose spell their own way. */
const EVENT_ALIAS = {
  BeforeTool: 'PreToolUse',
  AfterTool: 'PostToolUse',
  BeforeAgent: 'UserPromptSubmit',
  AfterAgent: 'Stop',
};

/**
 * The fields every module reads, filled in from where a hand-installed CLI keeps them: Goose sends
 * `event`, `working_dir`, `message` (the prompt) and `tool_call_id`; Kimi `tool_call_id`; Gemini its
 * own event names. Claude, Qwen and Codex input comes back as the SAME object, untouched.
 */
export function withCommon(input) {
  if (!input || typeof input !== 'object') return input;
  const cli = cliOf(input);
  if (!isHandInstalled(cli)) return input;
  const event = String(input.hook_event_name ?? input.event ?? '');
  return {
    ...input,
    hook_event_name: EVENT_ALIAS[event] ?? event,
    cwd: input.cwd ?? input.working_dir ?? input.directory,
    ...(input.prompt === undefined && typeof input.message === 'string'
      ? { prompt: input.message }
      : {}),
    ...(input.tool_use_id === undefined && input.tool_call_id !== undefined
      ? { tool_use_id: input.tool_call_id }
      : {}),
    agentdeck_cli: cli,
  };
}

const joinEdits = (edit, key) =>
  (Array.isArray(edit) ? edit : [edit])
    .map((e) => (e && typeof e === 'object' ? String(e[key] ?? '') : ''))
    .join('\n');

/** One call of a hand-installed CLI in Claude's shape: tool name, `file_path`, edit and shell fields. */
function dialectCall(cli, input, ti) {
  const tool = String(input.tool_name ?? '');
  const tools = DIALECT_TOOLS[cli];
  const name = Object.hasOwn(tools, tool) ? tools[tool] : null;
  const common = withCommon(input);
  if (!name) return common;
  const file = ti.file_path ?? ti.filePath ?? ti.absolute_path ?? ti.absolutePath ?? ti.path;
  const tool_input = {
    ...ti,
    ...(file !== undefined && name !== 'Grep' && name !== 'Glob' ? { file_path: file } : {}),
  };
  if (name === 'Bash') {
    if (ti.is_background !== undefined && ti.run_in_background === undefined)
      tool_input.run_in_background = ti.is_background === true || ti.is_background === 'true';
    // The guards read Claude's ms; Kimi's `timeout` and Goose's `timeout_secs` are seconds.
    const seconds = cli === 'kimi' ? ti.timeout : cli === 'goose' ? ti.timeout_secs : undefined;
    if (Number(seconds) > 0) tool_input.timeout = Number(seconds) * 1000;
    else if (cli === 'kimi' || cli === 'goose') delete tool_input.timeout;
  }
  if (name === 'Edit') {
    if (cli === 'kimi' && ti.edit !== undefined) {
      tool_input.old_string = joinEdits(ti.edit, 'old');
      tool_input.new_string = joinEdits(ti.edit, 'new');
    } else if (cli === 'goose') {
      tool_input.old_string = String(ti.before ?? '');
      tool_input.new_string = String(ti.after ?? '');
    } else if (cli === 'opencode') {
      tool_input.old_string = String(ti.oldString ?? '');
      tool_input.new_string = String(ti.newString ?? '');
    }
  }
  if (name === 'Agent' && ti.prompt === undefined && ti.task !== undefined)
    tool_input.prompt = ti.task;
  return { ...common, tool_name: name, tool_input };
}

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
  // OpenCode's `apply_patch` (GPT models) carries Codex's patch format in `patchText`.
  const patch = tool === 'apply_patch' && (cli === 'codex' || cli === 'opencode');
  if (isHandInstalled(cli) && !patch) return [dialectCall(cli, input, ti)];
  if (cli === 'qwen' && QWEN_TOOLS[tool]) {
    const name = QWEN_TOOLS[tool];
    const file = ti.file_path ?? ti.absolute_path ?? ti.absolutePath ?? ti.path;
    const tool_input = {
      ...ti,
      ...(file !== undefined && name !== 'Grep' && name !== 'Glob' ? { file_path: file } : {}),
    };
    // Qwen's shell names its background flag `is_background` (bundle 0.25); every guard reads Claude's.
    if (name === 'Bash' && ti.is_background !== undefined && ti.run_in_background === undefined)
      tool_input.run_in_background = ti.is_background === true || ti.is_background === 'true';
    if (name === 'Agent' && ti.prompt === undefined && ti.task !== undefined)
      tool_input.prompt = ti.task;
    return [{ ...input, tool_name: name, tool_input, agentdeck_cli: cli }];
  }
  if (patch) {
    const head = withCommon(input);
    const calls = patchCalls(ti.command ?? ti.patch ?? ti.input ?? ti.patchText);
    if (!calls.length) return [{ ...head, agentdeck_cli: cli }];
    return calls.map((c) => ({
      ...head,
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
