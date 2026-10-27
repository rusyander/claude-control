// Foreign CLI transcripts (codex, gemini, qwen, continue, goose, kimi, cursor, opencode, aider) → the Claude record
// shape core.mjs already judges, so every heuristic (DENY, ERR, REPEAT, RERUN, SLEEP, SLOW, BIG, CTX+, WORD, END,
// BURN) runs on a foreign group unchanged. Contract (core.mjs is the only caller):
//
//   foreignFiles(u, opts) → [{ f, role: 'main' | 'sub', sid, fmt, whole? }]
//     u.group.provider = CLI id, u.copy = the group's copy (its cwd). Return the session files of runs whose cwd is
//     the copy. `fmt` = the provider id (passed back to toClaude). `whole: true` = a JSON document rewritten in place
//     (not JSONL): core re-reads it whole when size or mtime moves.
//   toClaude(fmt, rec, st) → Claude-shaped records: { type: 'assistant', timestamp, message: { id, model,
//     stop_reason, content: [{type:'text',text} | {type:'tool_use',id,name,input}], usage } } and { type: 'user',
//     timestamp, message: { content: [{type:'tool_result', tool_use_id, content, is_error}] | string } }.
//     Tool names map to Claude names where the meaning matches (shell → Bash, read_file → Read, apply_patch → Edit),
//     so REPEAT/REREAD/RERUN keys line up. `st` is the file state (free scratch under st.fx).
//     JSONL formats: `rec` = one parsed line. Whole formats: `rec` = the parsed document; return ALL records in order,
//     core feeds only those past the count it already fed.
//   readRef(loc) → text of one record for show.mjs when loc.idx is set (whole-format refs carry no byte range).
//
// Until a provider is mapped here its unit stays status + signals only (footer FOREIGN … no transcript parser).
//
// Shapes were read from the CLIs themselves, never guessed from docs: codex 0.155.1 and qwen-code 0.24.3 from files
// the real CLIs wrote (agentdeck token-ledger/foreign/__fixtures__) plus the installed qwen bundle; continue cn 1.5.47
// and opencode 1.18.35 from their installed sources and real session files / db. Gemini is NOT installed here: its
// layout follows the upstream ChatRecordingService (session-*.json under tmp/<sha256(cwd)>/chats) — unverified.
// Unmapped, and why (one line each, so nobody re-researches them):
//   goose  — sqlite `messages` rows are UPDATEd and DELETEd in place (no settle point); no real run to check against.
//   kimi   — Kimi Code 2.x writes nothing locally the panel's runs use (the panel drives `kimi web`); no file to read.
//   cursor — the catalog marks it cliRunnable:false: no group ever runs it.
//   aider  — the panel runs aider with --chat-history-file on the null device; its markdown carries no ids/exits.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const MAPPED = new Set(['codex', 'qwen', 'gemini', 'continue', 'opencode']);

// ---- small helpers (no import from core.mjs: core imports this module) ------------------------------------------
const isWin = process.platform === 'win32';
const native = (p) => {
  const s = String(p ?? '');
  return isWin && /^\/[a-zA-Z](?:\/|$)/.test(s) ? `${s[1].toUpperCase()}:${s.slice(2) || '/'}` : s;
};
// A path as the CLIs store it: native, file:// URI (continue's IDE side), any slash, any drive-letter case.
const norm = (p) => {
  let s = String(p ?? '');
  if (/^file:\/\//i.test(s)) {
    s = decodeURIComponent(s.replace(/^file:\/\//i, ''));
    if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1);
  }
  const r = path.resolve(native(s)).replace(/[\\/]+$/, '');
  return isWin ? r.toLowerCase() : r;
};
const same = (a, b) => !!a && !!b && norm(a) === norm(b);
const inside = (child, parent) => {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + path.sep);
};
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' && v ? v : undefined);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const int = (v) => (typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : null);
const iso = (ms) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : undefined);
const json = (v) => {
  if (typeof v !== 'string') return obj(v) ?? {};
  try {
    return obj(JSON.parse(v)) ?? {};
  } catch {
    return {};
  }
};
const dir = (d) => {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
};
const stat = (f) => {
  try {
    return fs.statSync(f);
  } catch {
    return null;
  }
};
const textOf = (c) =>
  typeof c === 'string'
    ? c
    : arr(c)
        .map((p) => (typeof p === 'string' ? p : p?.thought ? '' : str(p?.text) ?? str(p?.content) ?? ''))
        .filter(Boolean)
        .join('\n');
// A session the group could still be writing: its file moved after the unit was added, less a margin (a group
// watched after it started keeps the session it is in).
const floorOf = (u) => Math.min(Number(u.addedAt) || Date.now(), Date.now()) - 3 * 86400e3;
const configRoot = (o) => native(o?.['config-root'] || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));

// ---- Claude-shaped record builders -------------------------------------------------------------------------------
// input counts every prompt token incl. the cached ones at all four CLIs that report a cache (codex, qwen, gemini,
// continue): the cached part is moved to cache_read so core's ctx (input + read + write) is the real window.
const use = (input, cached, output, written = 0) => {
  const read = Math.min(num(cached), num(input));
  return { input_tokens: num(input) - read, cache_read_input_tokens: read, cache_creation_input_tokens: num(written), output_tokens: num(output) };
};
const asst = (ts, id, model, content, x = {}) => ({
  type: 'assistant',
  timestamp: ts,
  message: { id, model: model ?? null, role: 'assistant', stop_reason: x.stop ?? null, content, ...(x.usage ? { usage: x.usage } : {}) },
});
const tu = (id, t) => ({ type: 'tool_use', id, name: t.name, input: t.input });
const apiErr = (ts, id, text) => ({ type: 'assistant', timestamp: ts, isApiErrorMessage: true, message: { id, model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: text || 'API error' }] } });
const prompt = (ts, text) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const sys = (ts, subtype, x = {}) => ({ type: 'system', subtype, timestamp: ts, ...x });
const PAD = { type: 'summary' }; // core skips it: fills the slots of records a whole document already fed
const DENIED = /Permission to use [\w:.-]+ (?:has been|was) denied|The user doesn't want to proceed with this tool use/;
// One tool result. The shapes core keys on are written here, once: a refusal opens with the Claude denial text (DENY),
// an abort with «[Request interrupted by user» (INTR), a non-zero shell exit with «Exit code N» (ERR / benign grep).
function result(ts, id, text, f = {}) {
  let body = String(text ?? '');
  let err = !!f.err;
  if (f.deny) {
    if (!DENIED.test(body)) body = `The user doesn't want to proceed with this tool use. ${body}`.trim();
    err = true;
  } else if (f.intr) body = `[Request interrupted by user] ${body}`.trim();
  else if (f.timeout) {
    if (!/Command timed out|timed out after/i.test(body)) body = `Command timed out\n${body}`;
    err = true;
  } else if (f.exit !== null && f.exit !== undefined && f.exit !== 0) {
    if (!/^Exit code -?\d+/.test(body)) body = `Exit code ${f.exit}\n${body}`;
    err = true;
  }
  const r = { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: body, is_error: err }] } };
  if (num(f.size) > body.length) r.toolUseResult = { persistedOutputSize: f.size };
  return r;
}

// ---- tool names → Claude names ------------------------------------------------------------------------------------
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
const bash = (command, timeoutMs, bg) => ({ name: 'Bash', input: clean({ command: command ?? '', timeout: num(timeoutMs) || undefined, run_in_background: bg === true ? true : undefined }) });
// argv from codex `shell` / local_shell: `bash -lc "<cmd>"`, `pwsh -Command <cmd>`, `cmd /c <cmd>` → the command.
const argvText = (v) => {
  if (!Array.isArray(v)) return str(v);
  const a = v.filter((x) => typeof x === 'string');
  const i = a.findIndex((x) => /^(?:-l?c|-Command|\/c)$/i.test(x));
  return i >= 0 && i < a.length - 1 ? a.slice(i + 1).join(' ') : a.join(' ');
};
// `*** Begin Patch` (codex apply_patch, opencode apply_patch): one Claude call per touched file.
function patchCalls(id, patch) {
  const files = [];
  let cur = null;
  for (const raw of String(patch ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if (m) files.push((cur = { op: m[1], file: m[2].trim(), minus: [], plus: [] }));
    else if (cur && !line.startsWith('***')) {
      if (line.startsWith('+')) cur.plus.push(line.slice(1));
      else if (line.startsWith('-')) cur.minus.push(line.slice(1));
    }
  }
  if (!files.length) return [{ id, name: 'Edit', input: {} }];
  return files.map((p, i) => ({
    id: i ? `${id}#${i + 1}` : id,
    name: p.op === 'Add' ? 'Write' : 'Edit',
    input: p.op === 'Add' ? { file_path: p.file, content: p.plus.join('\n') } : { file_path: p.file, old_string: p.minus.join('\n'), new_string: p.plus.join('\n') },
  }));
}
const SHELL = new Set(['exec_command', 'shell', 'shell_command', 'local_shell', 'container.exec']);
function mapCodex(name, a) {
  if (SHELL.has(name)) return bash(argvText(a.cmd) ?? argvText(a.command), a.timeout_ms ?? a.timeout);
  if (name === 'read_file') return { name: 'Read', input: clean({ file_path: str(a.file_path) ?? str(a.path), offset: a.offset, limit: a.limit }) };
  if (name === 'view_image') return { name: 'Read', input: clean({ file_path: str(a.path) }) };
  return { name, input: a };
}
// Gemini CLI and its fork Qwen Code share the tool set.
function mapGem(name, a) {
  switch (name) {
    case 'run_shell_command':
      return bash(str(a.command), a.timeout, a.is_background);
    case 'read_file':
      return { name: 'Read', input: clean({ file_path: str(a.absolute_path) ?? str(a.file_path) ?? str(a.path), offset: a.offset, limit: a.limit }) };
    case 'read_many_files': {
      const p = arr(a.paths);
      return p.length === 1 ? { name: 'Read', input: { file_path: String(p[0]) } } : { name, input: a };
    }
    case 'write_file':
      return { name: 'Write', input: clean({ file_path: str(a.file_path) ?? str(a.absolute_path), content: a.content }) };
    case 'edit':
    case 'replace':
      return { name: 'Edit', input: clean({ file_path: str(a.file_path) ?? str(a.absolute_path), old_string: a.old_string, new_string: a.new_string, replace_all: num(a.expected_replacements) > 1 || a.replace_all === true ? true : undefined }) };
    case 'grep_search':
    case 'search_file_content':
    case 'grep':
      return { name: 'Grep', input: clean({ pattern: a.pattern, path: a.path ?? a.dir_path, glob: a.include ?? a.glob }) };
    case 'glob':
      return { name: 'Glob', input: clean({ pattern: a.pattern, path: a.path ?? a.dir_path }) };
    default:
      return { name, input: a };
  }
}
// Continue: cn's own tools (Bash, Read, Write, Edit, MultiEdit, Search) and the IDE extension's (run_terminal_command…).
function mapContinue(name, a) {
  const file = str(a.filepath) ?? str(a.file_path) ?? str(a.path);
  switch (name) {
    case 'Bash':
    case 'run_terminal_command':
      return bash(str(a.command), num(a.timeout) * 1000, a.waitForCompletion === false);
    case 'Read':
    case 'read_file':
      return { name: 'Read', input: clean({ file_path: file, offset: a.offset, limit: a.limit }) };
    case 'Write':
    case 'create_new_file':
      return { name: 'Write', input: clean({ file_path: file, content: a.content ?? a.contents }) };
    case 'Edit':
    case 'single_find_and_replace':
      return { name: 'Edit', input: clean({ file_path: file, old_string: a.old_string, new_string: a.new_string, replace_all: a.replace_all === true ? true : undefined }) };
    case 'edit_existing_file':
      return { name: 'Edit', input: clean({ file_path: file, new_string: a.changes }) };
    case 'MultiEdit':
    case 'multi_edit':
      return { name: 'MultiEdit', input: clean({ file_path: file, edits: arr(a.edits) }) };
    case 'Search':
    case 'grep_search':
      return { name: 'Grep', input: clean({ pattern: a.pattern ?? a.query, path: a.path }) };
    case 'file_glob_search':
      return { name: 'Glob', input: clean({ pattern: a.pattern }) };
    default:
      return { name, input: a };
  }
}
function mapOpencode(name, a) {
  switch (name) {
    case 'bash':
      return bash(str(a.command), a.timeout);
    case 'read':
      return { name: 'Read', input: clean({ file_path: str(a.filePath), offset: a.offset, limit: a.limit }) };
    case 'write':
      return { name: 'Write', input: clean({ file_path: str(a.filePath), content: a.content }) };
    case 'edit':
      return { name: 'Edit', input: clean({ file_path: str(a.filePath), old_string: a.oldString, new_string: a.newString, replace_all: a.replaceAll === true ? true : undefined }) };
    case 'multiedit':
      return { name: 'MultiEdit', input: clean({ file_path: str(a.filePath), edits: arr(a.edits).map((e) => ({ old_string: e?.oldString, new_string: e?.newString })) }) };
    case 'grep':
      return { name: 'Grep', input: clean({ pattern: a.pattern, path: a.path, glob: a.include }) };
    case 'glob':
      return { name: 'Glob', input: clean({ pattern: a.pattern, path: a.path }) };
    case 'task':
      return { name: 'Agent', input: clean({ description: a.description, subagent_type: a.subagent_type }) };
    default:
      return { name, input: a };
  }
}
// A call list → one assistant record + immediate results for the extra files of a multi-file patch (one CLI call,
// one CLI result: the extra Claude calls are closed at once, else they would stay OPEN forever).
function calls(ts, id, model, list) {
  const out = [asst(ts, id, model, list.map((c) => tu(c.id, c)), { stop: 'tool_use' })];
  for (const c of list.slice(1)) if (/#\d+$/.test(c.id)) out.push(result(ts, c.id, '(same patch as the first file)'));
  return out;
}

// ---- codex (JSONL rollout) ----------------------------------------------------------------------------------------
// Tool output: «… Process exited with code N … Output:\n<body>» (exec_command), «Exit code: N … Output:» (shell_command),
// a JSON string {output, metadata:{exit_code}} (older shell), or an object {content, success}.
function codexOut(output) {
  let text;
  let exit = null;
  let err = false;
  if (obj(output)) {
    text = textOf(output.content) || (typeof output.content === 'string' ? output.content : JSON.stringify(output.content ?? ''));
    if (output.success === false) err = true;
  } else {
    text = String(output ?? '');
    if (/^\s*\{/.test(text)) {
      const j = json(text);
      if ('output' in j) {
        exit = int(obj(j.metadata)?.exit_code);
        text = String(j.output ?? '');
      }
    }
  }
  const split = /(?:^|\n)Output:\r?\n([\s\S]*)$/.exec(text);
  const head = split ? text.slice(0, split.index) : text.slice(0, 300);
  if (exit === null) {
    const m = /^(?:Process exited with code|Exit code:?)\s*(-?\d+)/m.exec(head);
    if (m) exit = Number(m[1]);
  }
  return {
    text: (split ? split[1] : text).replace(/\s+$/, ''),
    exit,
    err,
    deny: /\brejected by user\b|declined by (?:the )?user|denied by (?:the )?user/i.test(head),
    timeout: /command timed out|timed out after/i.test(head),
  };
}
function codexItem(p, ts, fx) {
  if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
    const id = str(p.call_id) ?? str(p.id) ?? `cx${ts}`;
    const name = p.type === 'local_shell_call' ? 'local_shell' : str(p.name);
    if (!name) return [];
    const args = p.type === 'function_call' ? json(p.arguments) : p.type === 'custom_tool_call' ? { input: p.input } : obj(p.action) ?? {};
    const list = name === 'apply_patch' ? patchCalls(id, args.input ?? args.patch) : [{ id, ...mapCodex(name, args) }];
    return calls(ts, str(p.id) ?? `call:${id}`, fx.model, list);
  }
  if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
    const id = str(p.call_id);
    if (!id) return [];
    const o = codexOut(p.output);
    if (p.type === 'custom_tool_call_output' && o.exit === null && /^(?:error|apply_patch verification failed|failed|invalid patch)/i.test(o.text)) o.err = true;
    return [result(ts, id, o.text, o)];
  }
  if (p.type === 'message' && p.role === 'assistant') {
    const text = textOf(p.content);
    if (!text) return [];
    const id = str(p.id) ?? `cxm:${ts}`;
    fx.lastText = id;
    return [asst(ts, id, fx.model, [{ type: 'text', text }])];
  }
  return [];
}
function compactOnce(fx, ts, trigger) {
  const t = Date.parse(ts) || 0;
  if (fx.compAt && Math.abs(t - fx.compAt) < 10000) return [];
  fx.compAt = t;
  return [sys(ts, 'compact_boundary', { compactMetadata: { trigger, preTokens: fx.ctx ?? 0, postTokens: 0 } })];
}
function codexEvent(p, ts, fx) {
  switch (p.type) {
    case 'task_started':
      fx.lastText = null;
      fx.streamErr = false;
      return [];
    case 'user_message':
      return str(p.message) ? [prompt(ts, p.message)] : [];
    case 'item_completed': {
      const it = obj(p.item) ?? {};
      const text = it.type === 'UserMessage' ? textOf(it.content) : '';
      return text ? [prompt(ts, text)] : [];
    }
    case 'task_complete': {
      const text = str(p.last_agent_message);
      const id = fx.lastText ?? `end:${p.turn_id ?? ts}`;
      fx.lastText = null;
      // The end reuses the last answer's id: no second usage, no second WORD, one END.
      return text ? [asst(ts, id, fx.model, [{ type: 'text', text }], { stop: 'end_turn' })] : [sys(ts, 'turn_duration')];
    }
    case 'turn_aborted':
      fx.lastText = null;
      return [prompt(ts, `[Request interrupted by user] turn aborted${p.reason ? ` (${p.reason})` : ''}`), sys(ts, 'turn_duration')];
    case 'error':
      return [apiErr(ts, `cxe:${ts}`, str(p.message) ?? 'error')];
    case 'stream_error':
      // Reconnect attempts repeat inside one turn: the first one is the news.
      if (fx.streamErr) return [];
      fx.streamErr = true;
      return [apiErr(ts, `cxs:${ts}`, `stream error: ${str(p.message) ?? ''}`)];
    case 'context_compacted':
      return compactOnce(fx, ts, 'auto');
    case 'token_count': {
      const out = [];
      const rl = str(obj(p.rate_limits)?.rate_limit_reached_type);
      if (rl && rl !== fx.rl) out.push(apiErr(ts, `cxl:${ts}`, `rate limit reached: ${rl}`));
      fx.rl = rl ?? null;
      // Older codex wrote no token_usage_record: its token_count (repeated, same totals) is the only trace.
      const info = obj(p.info);
      const last = obj(info?.last_token_usage);
      const total = num(obj(info?.total_token_usage)?.total_tokens);
      if (!fx.recs && last && total && total !== fx.lastTotal) {
        fx.lastTotal = total;
        fx.ctx = num(last.input_tokens);
        out.push(asst(ts, `tc:${total}`, fx.model, [], { usage: use(last.input_tokens, last.cached_input_tokens, last.output_tokens, last.cache_write_input_tokens) }));
      }
      return out;
    }
    default:
      return [];
  }
}
function codex(r, st) {
  const fx = (st.fx ??= {});
  const ts = r.timestamp;
  const p = obj(r.payload) ?? {};
  switch (r.type) {
    case 'turn_context':
      fx.model = str(p.model) ?? fx.model;
      return [];
    case 'compacted':
      return compactOnce(fx, ts, 'auto');
    case 'token_usage_record': {
      fx.recs = (fx.recs ?? 0) + 1;
      const u = obj(p.usage) ?? {};
      fx.ctx = num(u.input_tokens);
      return [asst(ts, str(p.response_id) ?? `tu:${ts}`, fx.model, [], { usage: use(u.input_tokens, u.cached_input_tokens, u.output_tokens, u.cache_write_input_tokens) })];
    }
    case 'event_msg':
      return codexEvent(p, ts, fx);
    case 'response_item':
      return codexItem(p, ts, fx);
    default:
      return [];
  }
}

// ---- qwen (JSONL chat) --------------------------------------------------------------------------------------------
function qwen(r, st) {
  const fx = (st.fx ??= {});
  const ts = r.timestamp;
  const parts = arr(obj(r.message)?.parts);
  if (r.type === 'user') {
    // CLI-made user records (reminders, tool plumbing) are not prompts; a mid-turn message is an injected prompt.
    if (r.provenance && r.provenance !== 'real_user' && r.subtype !== 'mid_turn_user_message') return [];
    const text = textOf(parts);
    return text ? [prompt(ts, text)] : [];
  }
  if (r.type === 'assistant') {
    const content = [];
    for (const p of parts) {
      const fc = obj(p?.functionCall);
      if (fc && str(fc.name)) content.push(tu(str(fc.id) ?? `q${ts}${content.length}`, mapGem(fc.name, obj(fc.args) ?? {})));
      else if (str(p?.text) && !p.thought) content.push({ type: 'text', text: p.text });
    }
    if (!content.length) return [];
    fx.n = (fx.n ?? 0) + 1;
    // Usage comes from ui_telemetry api_response (one per response); usageMetadata only while none was seen.
    const um = !fx.tel ? obj(r.usageMetadata) : null;
    const tools = content.some((c) => c.type === 'tool_use');
    return [
      asst(ts, `q:${ts}:${fx.n}`, str(r.model), content, {
        // A text-only reply ends the turn: qwen loops on function calls only.
        stop: tools ? 'tool_use' : 'end_turn',
        usage: um ? use(um.promptTokenCount, um.cachedContentTokenCount, num(um.candidatesTokenCount) + num(um.thoughtsTokenCount)) : undefined,
      }),
    ];
  }
  if (r.type === 'tool_result') {
    const tcr = obj(r.toolCallResult) ?? {};
    const out = [];
    for (const p of parts) {
      const fr = obj(p?.functionResponse);
      const id = str(fr?.id);
      if (!id) continue;
      const resp = obj(fr.response) ?? {};
      const mine = !tcr.callId || tcr.callId === id;
      const status = mine ? str(tcr.status) : undefined;
      const e = resp.error;
      const text = typeof resp.output === 'string' ? resp.output : e !== undefined ? (typeof e === 'string' ? e : JSON.stringify(e)) : JSON.stringify(resp.output ?? resp);
      const disp = mine ? obj(tcr.resultDisplay) : null;
      const exit = int(disp?.exitCode) ?? int(/\bExit Code: (-?\d+)/.exec(text)?.[1]);
      out.push(result(ts, id, text, { err: status === 'error' || e !== undefined, deny: status === 'cancelled', exit, timeout: /timed? ?out/i.test(String(disp?.outcome ?? '')) }));
    }
    return out;
  }
  if (r.type !== 'system') return [];
  const sp = obj(r.systemPayload) ?? {};
  if (r.subtype === 'ui_telemetry') {
    const e = obj(sp.uiEvent) ?? {};
    if (e['event.name'] === 'qwen-code.api_response') {
      fx.tel = true;
      return [asst(ts, str(e.response_id) ?? `qr:${ts}`, str(e.model), [], { usage: use(e.input_token_count, e.cached_content_token_count, num(e.output_token_count) + num(e.thoughts_token_count)) })];
    }
    if (e['event.name'] === 'qwen-code.api_error') return [apiErr(ts, `qe:${ts}`, `${e.status_code ?? ''} ${e.error_type ?? ''}: ${e.error_message ?? e.error ?? ''}`.trim())];
    return [];
  }
  if (r.subtype === 'chat_compression') {
    const i = obj(sp.info) ?? {};
    return [sys(ts, 'compact_boundary', { compactMetadata: { trigger: i.triggerReason === 'manual' ? 'manual' : 'auto', preTokens: num(i.originalTokenCount), postTokens: num(i.newTokenCount) } })];
  }
  if (r.subtype === 'turn_result') {
    // ACP mode only: the turn's own verdict.
    const state = str(sp.state) ?? str(r.state);
    const err = obj(sp.error) ?? obj(r.error);
    if (state === 'cancelled') return [prompt(ts, '[Request interrupted by user] turn cancelled'), sys(ts, 'turn_duration')];
    if (state === 'error') return [apiErr(ts, `qt:${ts}`, str(err?.message) ?? 'turn error'), sys(ts, 'turn_duration')];
    return [sys(ts, 'turn_duration')];
  }
  return [];
}

// ---- whole documents: an append-only ledger -----------------------------------------------------------------------
// A whole format is re-parsed on every rewrite. Each settled record gets a stable key; a key is fed once, in the order
// it settled. The returned list keeps the count core already fed (PAD slots) and appends only the new keys, so a record
// that settles late (a tool result filled in place) is still fed, and nothing is fed twice.
function ledger(st, items) {
  const fx = (st.fx ??= {});
  const keys = (fx.keys ??= []);
  const seen = new Set(keys);
  const fresh = items.filter((x) => !seen.has(x.key) && (seen.add(x.key), true));
  for (const x of fresh) keys.push(x.key);
  // keys[i - drop] is the key of fed record i (readRef opens a ref by it); the oldest fall off past the cap.
  if (keys.length > 20000) fx.drop = (fx.drop ?? 0) + keys.splice(0, keys.length - 20000).length;
  const out = new Array(fx.n ?? 0).fill(PAD);
  for (const x of fresh) out.push(x.rec);
  fx.n = out.length;
  return out;
}

// gemini: {sessionId, messages:[{id, timestamp, type: user|gemini|error|info|warning, content, toolCalls, tokens, model}]}.
function gemini(doc) {
  const msgs = arr(doc?.messages);
  const out = [];
  msgs.forEach((m, i) => {
    const ts = m?.timestamp;
    const id = str(m?.id) ?? `g${i}`;
    if (m?.type === 'user') {
      const t = textOf(m.content);
      if (t) out.push({ key: `u:${id}`, rec: prompt(ts, t) });
      return;
    }
    if (m?.type === 'error') return void out.push({ key: `e:${id}`, rec: apiErr(ts, `ge:${id}`, textOf(m.content)) });
    if (m?.type !== 'gemini') return;
    const tok = obj(m.tokens);
    const list = arr(m.toolCalls);
    const text = textOf(m.content);
    // A reply is settled once its tokens are recorded or a later message exists.
    if (tok || i < msgs.length - 1) {
      out.push({
        key: `m:${id}`,
        rec: asst(ts, id, str(m.model), text ? [{ type: 'text', text }] : [], {
          stop: !list.length && text ? 'end_turn' : null,
          usage: tok ? use(tok.input, tok.cached, num(tok.output) + num(tok.thoughts)) : undefined,
        }),
      });
    }
    for (const c of list) {
      const cid = str(c?.id) ?? `${id}:${c?.name}`;
      out.push({ key: `t:${cid}`, rec: asst(c.timestamp ?? ts, id, str(m.model), [tu(cid, mapGem(str(c.name) ?? '?', obj(c.args) ?? {}))], { stop: 'tool_use' }) });
      if (!['success', 'error', 'cancelled'].includes(c.status)) continue;
      const fr = arr(c.result).map((p) => obj(obj(p?.functionResponse)?.response)).find(Boolean);
      const body = fr ? (typeof fr.output === 'string' ? fr.output : fr.error !== undefined ? String(fr.error?.message ?? fr.error) : JSON.stringify(fr)) : typeof c.resultDisplay === 'string' ? c.resultDisplay : textOf(c.result);
      out.push({ key: `r:${cid}`, rec: result(c.timestamp ?? ts, cid, body, { err: c.status === 'error', deny: c.status === 'cancelled', exit: int(/\bExit Code: (-?\d+)/.exec(body)?.[1]) }) });
    }
  });
  return out;
}

// continue: {sessionId, workspaceDirectory, history:[{message:{role, content, toolCalls, usage}, toolCallStates}]}.
// No timestamps in the file: core stamps the read time.
const CONT_DONE = new Set(['done', 'errored', 'canceled']);
function continueDoc(doc) {
  const hist = arr(doc?.history);
  const out = [];
  const contResult = (id, text, status) =>
    result(undefined, id, text, { err: status === 'errored', deny: status === 'canceled', exit: status === 'errored' ? int(/exit code (-?\d+)/i.exec(text)?.[1]) : null, timeout: /\[Command timed out after/.test(text) });
  hist.forEach((h, i) => {
    const m = obj(h?.message) ?? {};
    if (m.role === 'user') {
      const t = textOf(m.content);
      if (t) out.push({ key: `u:${i}`, rec: prompt(undefined, t) });
      return;
    }
    if (m.role === 'tool') {
      const id = str(m.toolCallId) ?? str(m.tool_call_id);
      if (id) out.push({ key: `r:${id}`, rec: contResult(id, textOf(m.content), str(m.status) ?? 'done') });
      return;
    }
    if (m.role !== 'assistant') return;
    const id = `c:${i}`;
    const tcs = arr(h.toolCallStates);
    const list = arr(m.toolCalls).map((c) => {
      const s = tcs.find((x) => x?.toolCallId === c?.id);
      return { c, s };
    });
    const ready = list.length > 0 && list.every(({ s }) => !s || s.status !== 'generating');
    const us = obj(m.usage);
    const text = textOf(m.content);
    if (us || ready || i < hist.length - 1) {
      out.push({
        key: `a:${i}`,
        rec: asst(undefined, id, str(us?.model) ?? null, text ? [{ type: 'text', text }] : [], {
          stop: !list.length && text ? 'end_turn' : null,
          usage: us ? use(us.prompt_tokens, obj(us.prompt_tokens_details)?.cached_tokens, us.completion_tokens, obj(us.prompt_tokens_details)?.cache_write_tokens) : undefined,
        }),
      });
    }
    if (!ready) return;
    for (const { c, s } of list) {
      const cid = str(c?.id) ?? `${id}:${c?.function?.name}`;
      const args = obj(s?.parsedArgs) ?? json(c?.function?.arguments);
      out.push({ key: `t:${cid}`, rec: asst(undefined, id, null, [tu(cid, mapContinue(str(c?.function?.name) ?? '?', args))], { stop: 'tool_use' }) });
      if (s && CONT_DONE.has(s.status)) out.push({ key: `r:${cid}`, rec: contResult(cid, arr(s.output).map((o) => String(o?.content ?? '')).join('\n'), s.status) });
    }
  });
  return out;
}

// opencode export (written by foreignFiles from opencode.db): {session, messages:[{id, info, parts:[{id, …}]}]}.
function ocResult(id, s) {
  const ts = iso(obj(s.time)?.end) ?? iso(obj(s.time)?.start);
  if (s.status === 'error') {
    const e = String(s.error ?? '');
    return result(ts, id, e, { err: true, deny: /rejected permission/i.test(e), intr: /\baborted\b/i.test(e) && !/rejected permission/i.test(e) });
  }
  const out = String(s.output ?? '');
  const meta = obj(s.metadata) ?? {};
  return result(ts, id, out, { exit: int(meta.exit), timeout: /terminated command after exceeding timeout/i.test(out), size: num(s.outputLen) });
}
function opencodeDoc(doc) {
  const out = [];
  for (const m of arr(doc?.messages)) {
    const info = obj(m?.info) ?? {};
    const mid = str(m?.id) ?? '?';
    const parts = arr(m?.parts);
    const ts = iso(obj(info.time)?.created);
    if (info.role === 'user') {
      for (const p of parts) {
        if (p?.type === 'text' && !p.synthetic && str(p.text)) out.push({ key: `u:${p.id}`, rec: prompt(ts, p.text) });
        else if (p?.type === 'compaction') out.push({ key: `k:${p.id}`, rec: sys(ts, 'compact_boundary', { compactMetadata: { trigger: p.auto === false ? 'manual' : 'auto', preTokens: 0, postTokens: 0 } }) });
      }
      continue;
    }
    if (info.role !== 'assistant') continue;
    const model = str(info.modelID) ?? null;
    const done = !!obj(info.time)?.completed || !!info.error;
    const texts = [];
    let steps = 0;
    let tools = 0;
    for (const p of parts) {
      if (p?.type === 'tool') {
        tools += 1;
        const s = obj(p.state) ?? {};
        const cid = str(p.callID) ?? str(p.id) ?? '?';
        if (!['running', 'completed', 'error'].includes(s.status)) continue;
        const at = iso(obj(s.time)?.start) ?? ts;
        const input = obj(s.input) ?? {};
        const list = p.tool === 'apply_patch' ? patchCalls(cid, input.patchText) : [{ id: cid, ...mapOpencode(str(p.tool) ?? '?', input) }];
        out.push({ key: `t:${cid}`, rec: calls(at, `${mid}:t`, model, list) });
        if (s.status !== 'running') out.push({ key: `r:${cid}`, rec: [ocResult(cid, s)] });
      } else if (p?.type === 'step-finish') {
        steps += 1;
        const t = obj(p.tokens) ?? {};
        const c = obj(t.cache) ?? {};
        // opencode's input already excludes the cache; reasoning is billed as output.
        out.push({ key: `s:${p.id}`, rec: asst(ts, `s:${p.id}`, model, [], { usage: { input_tokens: num(t.input), cache_read_input_tokens: num(c.read), cache_creation_input_tokens: num(c.write), output_tokens: num(t.output) + num(t.reasoning) } }) });
      } else if (p?.type === 'text' && !p.synthetic && str(p.text)) texts.push(p);
    }
    if (!done) continue;
    if (!steps && obj(info.tokens)) {
      const t = info.tokens;
      out.push({ key: `m:${mid}`, rec: asst(ts, `m:${mid}`, model, [], { usage: { input_tokens: num(t.input), cache_read_input_tokens: num(t.cache?.read), cache_creation_input_tokens: num(t.cache?.write), output_tokens: num(t.output) + num(t.reasoning) } }) });
    }
    const end = !info.error && (str(info.finish) ? !/tool/i.test(info.finish) : !tools);
    texts.forEach((p, k) => {
      out.push({ key: `x:${p.id}`, rec: asst(iso(obj(p.time)?.end) ?? ts, `x:${p.id}`, model, [{ type: 'text', text: p.text }], { stop: end && k === texts.length - 1 ? 'end_turn' : null }) });
    });
    const at = iso(obj(info.time)?.completed) ?? ts;
    if (info.error) {
      const e = obj(info.error) ?? {};
      const d = obj(e.data) ?? {};
      if (e.name === 'MessageAbortedError') out.push({ key: `i:${mid}`, rec: [prompt(at, '[Request interrupted by user] aborted'), sys(at, 'turn_duration')] });
      else out.push({ key: `e:${mid}`, rec: apiErr(at, `e:${mid}`, `${e.name ?? 'Error'}${d.statusCode ? ` ${d.statusCode}` : ''}: ${d.message ?? ''}`) });
    } else if (end && !texts.length) out.push({ key: `d:${mid}`, rec: sys(at, 'turn_duration') });
  }
  return out;
}
const WHOLE = { gemini, continue: continueDoc, opencode: opencodeDoc };
const LINES = { codex, qwen };

export function toClaude(fmt, rec, st) {
  if (LINES[fmt]) return LINES[fmt](obj(rec) ?? {}, st);
  if (WHOLE[fmt]) return ledger(st, flatten(WHOLE[fmt](rec)));
  return [];
}
// A key may carry several records (a call + the closed extras of a multi-file patch): one key per record.
function flatten(items) {
  const flat = [];
  for (const x of items) {
    const recs = Array.isArray(x.rec) ? x.rec : [x.rec];
    recs.forEach((r, i) => flat.push({ key: i ? `${x.key}~${i}` : x.key, rec: r }));
  }
  return flat;
}

// A whole-format record by its index, re-parsed from the document as it is now. Exact when the caller passes the
// file's ledger (loc.keys / loc.drop = st.fx.keys / st.fx.drop): the record whose key was fed at that index. Without
// it, best effort — the index in document order, which equals the fed order only for an append-only history (a
// tool result filled in place later settles out of document order).
export function readRef(loc) {
  try {
    const fmt = loc?.fmt ?? (/[\\/]opencode-[^\\/]+\.json$/.test(loc?.f ?? '') ? 'opencode' : null);
    if (!WHOLE[fmt]) return null;
    const flat = flatten(WHOLE[fmt](JSON.parse(fs.readFileSync(loc.f, 'utf8'))));
    const key = Array.isArray(loc.keys) ? loc.keys[loc.idx - (loc.drop ?? 0)] : undefined;
    const r = key !== undefined ? flat.find((x) => x.key === key)?.rec : Array.isArray(loc.keys) ? undefined : flat[loc.idx]?.rec;
    return r ? JSON.stringify(r) : null;
  } catch {
    return null;
  }
}

// ---- where each CLI keeps a session -------------------------------------------------------------------------------
// Codex: <CODEX_HOME|~/.codex>/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl; the project is session_meta.payload.cwd
// on line 1 (that line can be MBs: base_instructions). A decided file is cached in the unit, never re-peeked.
function codexCwd(f) {
  let fd;
  try {
    fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (!n) return undefined;
    const head = buf.subarray(0, n).toString('utf8');
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
    if (m) return JSON.parse(`"${m[1]}"`);
    const nl = buf.subarray(0, n).indexOf(0x0a);
    if (nl >= 0) return null; // a complete first line without a cwd: not a session of any copy
    const size = Math.min(fs.fstatSync(fd).size, 8 * 1024 * 1024);
    const all = Buffer.alloc(size);
    fs.readSync(fd, all, 0, size, 0);
    const end = all.indexOf(0x0a);
    if (end < 0) return undefined; // line 1 still being written
    return str(obj(json(all.subarray(0, end).toString('utf8')).payload)?.cwd) ?? null;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function findCodex(u, { fx }) {
  const root = path.join(native(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')), 'sessions');
  const since = floorOf(u);
  // Codex names the date dirs by local start date: a day of slack either way.
  const day = new Date(since - 86400e3).toISOString().slice(0, 10);
  const prev = fx.cx ?? {};
  const next = {};
  const out = [];
  const digits = (d) => dir(d).filter((n) => /^\d+$/.test(n));
  for (const y of digits(root)) {
    if (y < day.slice(0, 4)) continue;
    for (const m of digits(path.join(root, y))) {
      if (`${y}-${m}` < day.slice(0, 7)) continue;
      for (const d of digits(path.join(root, y, m))) {
        if (`${y}-${m}-${d}` < day) continue;
        const at = path.join(root, y, m, d);
        for (const n of dir(at)) {
          if (!/^rollout-.*\.jsonl$/.test(n)) continue;
          const f = path.join(at, n);
          let v = prev[f];
          if (v === undefined) {
            const s = stat(f);
            if (!s || s.mtimeMs < since) continue;
            const cwd = codexCwd(f);
            if (cwd === undefined) continue; // undecided: peeked again next pass
            v = same(cwd, u.copy) ? 1 : 0;
          }
          next[f] = v;
          if (v === 1) out.push({ f, role: 'main', sid: /([0-9a-f-]{36})\.jsonl$/i.exec(n)?.[1] ?? n.slice(0, -6), fmt: 'codex' });
        }
      }
    }
  }
  fx.cx = next;
  return out;
}
// Qwen Code: <home>/projects/<slug>/chats/<sid>.jsonl (+ archive/), slug = cwd (lower-cased on Windows) with every
// non-alphanumeric → '-'. Homes: QWEN_HOME|~/.qwen and the kit's own <config>/agentdeck/kit/qwen-home. The
// <sid>.ledger.jsonl beside each chat is request state, not the conversation.
function findQwen(u, { o }) {
  const abs = path.resolve(native(u.copy));
  const slug = (isWin ? abs.toLowerCase() : abs).replace(/[^a-zA-Z0-9]/g, '-');
  const homes = [...new Set([native(process.env.QWEN_HOME || path.join(os.homedir(), '.qwen')), path.join(configRoot(o), 'agentdeck', 'kit', 'qwen-home')])];
  const since = floorOf(u);
  const out = [];
  for (const h of homes) {
    const chats = path.join(h, 'projects', slug, 'chats');
    for (const d of [chats, path.join(chats, 'archive')]) {
      for (const n of dir(d)) {
        if (!n.endsWith('.jsonl') || n.endsWith('.ledger.jsonl')) continue;
        const f = path.join(d, n);
        if ((stat(f)?.mtimeMs ?? 0) >= since) out.push({ f, role: 'main', sid: n.slice(0, -6), fmt: 'qwen' });
      }
    }
  }
  return out;
}
// Gemini CLI: <GEMINI_CLI_HOME|~>/.gemini/tmp/<sha256(cwd)>/chats/session-*.json, or a named project dir whose
// .project_root names the cwd (newer releases). Unverified here: Gemini CLI is not installed on this machine.
function findGemini(u, { fx }) {
  const tmp = path.join(native(process.env.GEMINI_CLI_HOME || os.homedir()), '.gemini', 'tmp');
  const abs = path.resolve(native(u.copy));
  const now = Date.now();
  if (!fx.gm || now - fx.gm.at > 60000) {
    const variants = new Set([abs, abs.replace(/^[A-Z]:/, (x) => x.toLowerCase()), abs.replace(/^[a-z]:/, (x) => x.toUpperCase())]);
    const dirs = [...variants].map((v) => path.join(tmp, crypto.createHash('sha256').update(v).digest('hex'))).filter((d) => stat(d));
    for (const n of dir(tmp)) {
      try {
        if (same(fs.readFileSync(path.join(tmp, n, '.project_root'), 'utf8').trim(), abs)) dirs.push(path.join(tmp, n));
      } catch {
        /* not a named project dir */
      }
    }
    fx.gm = { at: now, dirs: [...new Set(dirs)] };
  }
  const since = floorOf(u);
  const out = [];
  for (const d of fx.gm.dirs) {
    const chats = path.join(d, 'chats');
    for (const n of dir(chats)) {
      if (!/^session-.*\.json$/.test(n)) continue;
      const f = path.join(chats, n);
      if ((stat(f)?.mtimeMs ?? 0) >= since) out.push({ f, role: 'main', sid: n.slice(8, -5), fmt: 'gemini', whole: true });
    }
  }
  return out;
}
// Continue (cn): <CONTINUE_GLOBAL_DIR|~/.continue>/sessions/<sid>.json, the project = its workspaceDirectory.
function findContinue(u, { fx }) {
  const d = path.join(native(process.env.CONTINUE_GLOBAL_DIR || path.join(os.homedir(), '.continue')), 'sessions');
  const since = floorOf(u);
  const prev = fx.ct ?? {};
  const next = {};
  const out = [];
  for (const n of dir(d)) {
    if (!n.endsWith('.json') || n === 'sessions.json') continue;
    const f = path.join(d, n);
    let v = prev[n];
    if (v === undefined) {
      if ((stat(f)?.mtimeMs ?? 0) < since) continue;
      let ws;
      try {
        ws = JSON.parse(fs.readFileSync(f, 'utf8')).workspaceDirectory;
      } catch {
        continue; // mid-write
      }
      if (!str(ws)) continue;
      v = same(ws, u.copy) ? 1 : 0;
    }
    next[n] = v;
    if (v === 1) out.push({ f, role: 'main', sid: n.slice(0, -5), fmt: 'continue', whole: true });
  }
  fx.ct = next;
  return out;
}
// opencode: <XDG_DATA_HOME|~/.local/share>/opencode/opencode.db (sqlite, WAL). Read-only; each session of the copy is
// exported to <state>/foreign/opencode-<sid>.json, rewritten only when its content moved — core then reads it as a
// whole document. Never exported into the copy itself (the watch writes nothing into the work it watches).
let sqlite;
function openDb(file) {
  if (sqlite === undefined) {
    const warn = process.emitWarning;
    process.emitWarning = (w, ...a) => (/sqlite/i.test(String(w?.message ?? w)) ? undefined : warn.call(process, w, ...a));
    try {
      sqlite = process.getBuiltinModule?.('node:sqlite') ?? null;
    } catch {
      sqlite = null;
    } finally {
      process.emitWarning = warn;
    }
  }
  return sqlite ? new sqlite.DatabaseSync(file, { readOnly: true }) : null;
}
const OUT_CAP = 4000;
function findOpencode(u, { fx, o }) {
  const db = path.join(native(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')), 'opencode', 'opencode.db');
  const stateDir = path.resolve(native(o?.state ?? path.join(process.cwd(), '.agent', 'tmp', 'watchdog', 'default')));
  if (inside(stateDir, u.copy)) return [];
  const sig = [db, `${db}-wal`].map((f) => {
    const s = stat(f);
    return s ? `${s.size}:${s.mtimeMs}` : '-';
  }).join('|');
  const cur = fx.oc ?? {};
  if (cur.sig === sig && arr(cur.files).every((x) => stat(x.f))) return cur.files;
  if (sig.startsWith('-')) return [];
  let h;
  try {
    h = openDb(db);
  } catch {
    return cur.files ?? [];
  }
  if (!h) return [];
  const files = [];
  const hashes = {};
  try {
    const since = floorOf(u);
    const sessions = h.prepare('SELECT id, parent_id, directory, time_updated FROM session').all().filter((s) => same(s.directory, u.copy) && Number(s.time_updated ?? since) >= since);
    const qm = h.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id');
    const qp = h.prepare('SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id');
    for (const s of sessions) {
      const byMsg = {};
      for (const p of qp.all(s.id)) {
        const d = json(p.data);
        const st = obj(d.state);
        // Tool output is capped in the export; its full length stays for BIG.
        if (st && typeof st.output === 'string' && st.output.length > OUT_CAP) Object.assign(st, { outputLen: st.output.length, output: st.output.slice(0, OUT_CAP) });
        if (typeof d.text === 'string' && d.text.length > OUT_CAP * 4) d.text = d.text.slice(0, OUT_CAP * 4);
        (byMsg[p.message_id] ??= []).push({ id: p.id, ...d });
      }
      const doc = { session: { id: s.id, parent: s.parent_id ?? null, directory: s.directory }, messages: qm.all(s.id).map((m) => ({ id: m.id, info: json(m.data), parts: byMsg[m.id] ?? [] })) };
      const text = JSON.stringify(doc);
      const hash = crypto.createHash('sha1').update(text).digest('hex');
      const f = path.join(stateDir, 'foreign', `opencode-${String(s.id).replace(/[^\w.-]/g, '_')}.json`);
      if (cur.h?.[s.id] !== hash || !stat(f)) {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(`${f}.tmp`, text);
        fs.renameSync(`${f}.tmp`, f);
      }
      hashes[s.id] = hash;
      // A child session (the task tool) is a subagent of its parent: core joins subs to their main by sid.
      files.push({ f, role: s.parent_id ? 'sub' : 'main', sid: s.parent_id ?? s.id, fmt: 'opencode', whole: true, ...(s.parent_id ? { agent: s.id } : {}) });
    }
  } catch {
    return cur.files ?? [];
  } finally {
    try {
      h.close();
    } catch {
      /* closed */
    }
  }
  fx.oc = { sig, files, h: hashes };
  return files;
}
const FIND = { codex: findCodex, qwen: findQwen, gemini: findGemini, continue: findContinue, opencode: findOpencode };

export function foreignFiles(u, opts = {}) {
  const prov = u?.group?.provider;
  if (!MAPPED.has(prov) || !u.copy) return [];
  u.cwd ??= u.copy; // paths in flags print relative to the copy
  return FIND[prov](u, { fx: (u.fx ??= {}), o: opts });
}
