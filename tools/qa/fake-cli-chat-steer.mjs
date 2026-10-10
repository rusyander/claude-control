/**
 * Исходник фальшивого `claude` для `check-chat-steer.mjs` (F-4): живая сессия
 * с потоковым вводом, которая держит ход занятым, чтобы сообщение человека
 * пришло ПОСРЕДИ него. Подменена только модель; протокол — как у настоящего
 * CLI 2.1.285 (замер в `live-session.ts`): строка `user`, пришедшая во время
 * хода, отдаётся модели на ближайшем шаге внутри ТОГО ЖЕ хода, `result` у хода
 * один, реплика ложится в транскрипт.
 *
 * Сценарии по слову в начале хода:
 * - `ДОЛГО` — ответ кусками по 400 мс до 14 с; сообщение, пришедшее за это
 *   время, — итог «УЧЁЛ: <текст>» в том же ходе;
 * - иначе — обычный ход «Принято: <текст>».
 * Каждый ход и каждое сообщение посреди хода — строка в `turns.jsonl`.
 *
 * Экспорт — строка: её исходник пишется в файл стенда.
 */
export const FAKE_STEER_CLI = String.raw`
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
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

const flag = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1]?.replace(/^"|"$/g, '') : undefined;
};
const session = flag('--resume') ?? flag('--session-id') ?? randomUUID();
const cwd = process.cwd();
const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(dir, { recursive: true });
const transcript = join(dir, session + '.jsonl');
let parentUuid = null;
function record(type, message) {
  const uuid = randomUUID();
  appendFileSync(transcript, JSON.stringify({ type, message, uuid, parentUuid, sessionId: session, cwd,
    timestamp: new Date().toISOString(), isSidechain: false, userType: 'external', version: '2.1.999' }) + '\n');
  parentUuid = uuid;
}
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (entry) => appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...entry }) + '\n');
const msgId = () => 'msg_' + randomUUID().replace(/-/g, '').slice(0, 20);

function assistant(text) {
  const message = { id: msgId(), type: 'message', role: 'assistant', model: 'fake-default',
    content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
  out({ type: 'assistant', message, session_id: session });
  record('assistant', message);
}
function delta(text) {
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
}
function result() {
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.001, duration_ms: 1,
    num_turns: 1, result: '', session_id: session, usage: { input_tokens: 1, output_tokens: 1 } });
}

let current = null;
async function runTurn(content) {
  record('user', { role: 'user', content });
  out({ type: 'system', subtype: 'init', session_id: session, model: 'fake-default', tools: [], cwd });
  if (!content.includes('ДОЛГО')) {
    log({ scenario: 'plain', prompt: content });
    assistant('Принято: ' + content);
    result();
    return;
  }
  current = { steers: [] };
  log({ scenario: 'long-start', prompt: content });
  let text = '';
  for (let step = 0; step < 35 && current.steers.length === 0; step += 1) {
    const part = step === 0 ? 'Считаю' : ' .';
    text += part;
    delta(part);
    await sleep(400);
  }
  const steers = current.steers;
  current = null;
  for (const steer of steers) record('user', { role: 'user', content: steer });
  const tail = steers.length ? ' УЧЁЛ: ' + steers.join(' | ') : ' НЕ_УСЛЫШАЛ';
  delta(tail);
  assistant(text + tail);
  result();
  log({ scenario: 'long-end', prompt: content, steers, results: 1 });
}

const queue = [];
let busy = false;
let stdinEnded = false;
async function pump() {
  if (busy) return;
  if (!queue.length) {
    if (stdinEnded) process.exit(0);
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
    const raw = message.message?.content;
    const content = typeof raw === 'string' ? raw : (raw ?? []).map((part) => part.text ?? '').join('');
    // Посреди хода — модели на ближайшем шаге, как у настоящего CLI.
    if (current) {
      current.steers.push(content);
      log({ scenario: 'steer-in', prompt: content });
      return;
    }
    queue.push(content);
    void pump();
  })
  .on('close', () => { stdinEnded = true; void pump(); });
`;
