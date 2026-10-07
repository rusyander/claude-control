/**
 * Исходник фальшивого `claude` для `check-chat-basics.mjs` (Ф22: chat-001,
 * -003, -005, -007, -009). Подменена только модель: протокол потокового ввода и
 * вывода, транскрипт и вызов прав через НАСТОЯЩИЙ мост панели из `--mcp-config`
 * — как у настоящего CLI. Каждый ход — строка в `turns.jsonl` рядом со
 * скриптом: argv процесса (модель, глубина), рабочая папка, текст хода и что
 * случилось.
 *
 * Сценарий выбирается словом в начале хода:
 * - `ПИНГ` — ответ «Понг» потоком, по кусочку с паузой (видно, что он течёт);
 * - `МОДЕЛЬ` — называет модель и глубину из своих флагов;
 * - `ВЛОЖЕНИЯ` — читает файлы, названные в ходе: размер PNG из заголовка и
 *   число страниц PDF — доказательство, что байты дошли до процесса;
 * - `УДАЛИ` — кладёт в рабочую папку tmp-delete-me.txt и просит права на
 *   `rm tmp-delete-me.txt`; удаляет, только если мост разрешил;
 * - `СЛОМАЙСЯ` — итог с ошибкой устаревшего CLI, как у настоящего;
 * - `ПРАВКА` — просит права на запись `note.txt` в рабочей папке; пишет, только
 *   если мост разрешил (ворота ветки в основной копии — `check-copy-offer-walk.mjs`).
 *
 * Экспорт — строка: её исходник пишется в файл стенда.
 */
export const FAKE_BASICS_CLI = String.raw`
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
if (!argv.includes('--input-format')) {
  process.stdout.write('2.1.999 (Claude Code)\n');
  process.exit(0);
}
const self = fileURLToPath(import.meta.url);
const LOG = self.replace(/[^\\/]+$/, 'turns.jsonl');
const ALIVE = self.replace(/[^\\/]+$/, '.stand-alive');
setInterval(() => { if (!existsSync(ALIVE)) process.exit(0); }, 250).unref();

const unq = (value) => (value === undefined ? undefined : value.replace(/^"|"$/g, ''));
const flag = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? unq(argv[at + 1]) : undefined;
};
const model = flag('--model') ?? '';
const effort = flag('--effort') ?? '';
const session = flag('--resume') ?? flag('--session-id') ?? randomUUID();
const cwd = process.cwd();
const projectsDir = join(process.env.CLAUDE_CONFIG_DIR, 'projects');
const dir = join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(dir, { recursive: true });
// Как настоящий CLI 2.1.286 (проверено 05.10.2026): --resume находит сессию в
// папке ЛЮБОГО проекта и дописывает в тот же файл, даже из другой рабочей папки.
const resumed = flag('--resume')
  ? readdirSync(projectsDir).map((name) => join(projectsDir, name, session + '.jsonl')).find((path) => existsSync(path))
  : undefined;
const transcript = resumed ?? join(dir, session + '.jsonl');
let parentUuid = null;
function record(type, message) {
  const uuid = randomUUID();
  appendFileSync(transcript, JSON.stringify({ type, message, uuid, parentUuid, sessionId: session, cwd,
    timestamp: new Date().toISOString(), isSidechain: false, userType: 'external', version: '2.1.999' }) + '\n');
  parentUuid = uuid;
}
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (entry) => appendFileSync(LOG, JSON.stringify({ at: Date.now(), cwd, model, effort, ...entry }) + '\n');

let mcp;
let nextId = 1;
const waiting = new Map();
function rpc(method, params) {
  const id = nextId++;
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve) => waiting.set(id, resolve));
}
const mcpFile = flag('--mcp-config');
if (mcpFile) {
  const guard = JSON.parse(readFileSync(mcpFile, 'utf8')).mcpServers?.['perm-guard'];
  if (guard) {
    mcp = spawn(guard.command, guard.args, { env: { ...process.env, ...guard.env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    createInterface({ input: mcp.stdout }).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const resolve = waiting.get(message.id);
      if (resolve) { waiting.delete(message.id); resolve(message); }
    });
    void rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
  }
}
async function approve(tool_name, input, tool_use_id) {
  if (!mcp) return { behavior: 'deny', message: 'no broker' };
  const reply = await rpc('tools/call', { name: 'approve', arguments: { tool_name, input, tool_use_id } });
  return JSON.parse(reply.result?.content?.[0]?.text ?? '{}');
}

const msgId = () => 'msg_' + randomUUID().replace(/-/g, '').slice(0, 20);
function init() { out({ type: 'system', subtype: 'init', session_id: session, model: model || 'fake-default', tools: [], cwd }); }
function assistant(content) {
  const message = { id: msgId(), type: 'message', role: 'assistant', model: model || 'fake-default', content,
    stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } };
  out({ type: 'assistant', message, session_id: session });
  record('assistant', message);
}
function result(extra = {}) {
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.001, duration_ms: 1,
    num_turns: 1, result: '', session_id: session, usage: { input_tokens: 1, output_tokens: 1 }, ...extra });
}
async function stream(parts, ms) {
  for (const part of parts) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } } });
    await sleep(ms);
  }
  return parts.join('');
}

function pngSize(path) {
  const bytes = readFileSync(path);
  return bytes.readUInt32BE(16) + '×' + bytes.readUInt32BE(20);
}
function pdfPages(path) {
  return (readFileSync(path, 'latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
}

async function runTurn(content) {
  record('user', { role: 'user', content });
  init();
  if (content.includes('СЛОМАЙСЯ')) {
    log({ scenario: 'error', prompt: content });
    result({ subtype: 'error_during_execution', is_error: true,
      result: 'API Error: 400 Claude Code 2.1.0 does not support this model; version 2.1.999 or newer is required' });
    return;
  }
  if (content.includes('ПИНГ')) {
    log({ scenario: 'ping', prompt: content });
    const text = await stream(['По', 'н', 'г'], 900);
    assistant([{ type: 'text', text }]);
    result();
    return;
  }
  if (content.includes('МОДЕЛЬ')) {
    log({ scenario: 'model', prompt: content });
    assistant([{ type: 'text', text: 'Модель ' + (model || 'по умолчанию') + ', глубина ' + (effort || 'по умолчанию') }]);
    result();
    return;
  }
  if (content.includes('ВЛОЖЕНИЯ')) {
    const files = [...content.matchAll(/([A-Za-z]:[\\/][^\s"'<>|]+|\/[^\s"'<>|]+)\.(png|pdf)/gi)].map((m) => m[0]);
    const png = files.find((f) => /\.png$/i.test(f) && existsSync(f));
    const pdf = files.find((f) => /\.pdf$/i.test(f) && existsSync(f));
    const text = 'Картинка PNG ' + (png ? pngSize(png) : 'не дошла') + ', в PDF страниц: ' + (pdf ? pdfPages(pdf) : 'не дошёл');
    log({ scenario: 'attach', prompt: content, files, png, pdf, text });
    assistant([{ type: 'text', text }]);
    result();
    return;
  }
  if (content.includes('УДАЛИ')) {
    const target = join(cwd, 'tmp-delete-me.txt');
    writeFileSync(target, 'delete me\n');
    const toolUse = { type: 'tool_use', id: 'toolu_' + randomUUID().replace(/-/g, '').slice(0, 16), name: 'Bash',
      input: { command: 'rm tmp-delete-me.txt', description: 'Удалить временный файл' } };
    assistant([toolUse]);
    const decision = await approve('Bash', toolUse.input, toolUse.id);
    const allowed = decision.behavior === 'allow';
    if (allowed) rmSync(target, { force: true });
    log({ scenario: 'delete', prompt: content, decision: decision.behavior, target, exists: existsSync(target) });
    const toolResult = { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id,
      content: allowed ? 'removed' : String(decision.message ?? 'denied'), is_error: !allowed }] };
    out({ type: 'user', message: toolResult, session_id: session });
    record('user', toolResult);
    assistant([{ type: 'text', text: allowed ? 'Файл удалён.' : 'Мне отказали в удалении — файл на месте.' }]);
    result();
    return;
  }
  // Перезапуск в копии просит повторить правку, которая не прошла.
  if (content.includes('ПРАВКА') || content.includes('edit that did not go through')) {
    // Пишущий вызов: в основной копии без «Правки в основной копии проекта»
    // мост придерживает его воротами ветки (projects-copies-003).
    const target = join(cwd, 'note.txt');
    const toolUse = { type: 'tool_use', id: 'toolu_' + randomUUID().replace(/-/g, '').slice(0, 16), name: 'Write',
      input: { file_path: target, content: 'правка агента' } };
    assistant([toolUse]);
    const decision = await approve('Write', toolUse.input, toolUse.id);
    const allowed = decision.behavior === 'allow';
    if (allowed) writeFileSync(target, 'правка агента');
    log({ scenario: 'edit', prompt: content, decision: decision.behavior, target, exists: existsSync(target) });
    const toolResult = { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id,
      content: allowed ? 'written' : String(decision.message ?? 'denied'), is_error: !allowed }] };
    out({ type: 'user', message: toolResult, session_id: session });
    record('user', toolResult);
    assistant([{ type: 'text', text: allowed ? 'Правка записана.' : 'Правку не дали.' }]);
    result();
    return;
  }
  log({ scenario: 'other', prompt: content });
  assistant([{ type: 'text', text: 'Готово.' }]);
  result();
}

const queue = [];
let busy = false;
let stdinEnded = false;
async function pump() {
  if (busy) return;
  if (!queue.length) {
    if (stdinEnded) { mcp?.kill(); process.exit(0); }
    return;
  }
  busy = true;
  try { await runTurn(queue.shift()); } finally { busy = false; }
  void pump();
}
createInterface({ input: process.stdin })
  .on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.type !== 'user') return;
    const content = message.message?.content;
    queue.push(typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join(''));
    void pump();
  })
  .on('close', () => { stdinEnded = true; void pump(); });
`;
