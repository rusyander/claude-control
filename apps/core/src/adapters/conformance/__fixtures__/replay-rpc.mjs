#!/usr/bin/env node
// Подставной CLI JSON-RPC по stdio: проигрывает запись rpc-tee.mjs (REPLAY_FIXTURE) по порядку.
// Строка CLI ("out") уходит в stdout сразу; строка клиента ("in") — ожидание: следующая строка
// stdin с тем же методом (ответ на запрос CLI — с тем же id). Id запросов клиента в ответах
// переписываются на те, что клиент послал сейчас. REPLAY_REWRITE — JSON [[было, стало], …] для
// строковых значений строк CLI (пути и команда хука времени записи). Всё, что клиент прислал, и
// argv/cwd/окружение — в REPLAY_DUMP после каждой строки. Клиент не прислал ожидаемого за
// REPLAY_WAIT_MS — причина в stderr, выход 3: несовпадение видно, а не зависает.
import { readFileSync, writeFileSync } from 'node:fs';

const fixture = process.env.REPLAY_FIXTURE;
const dumpFile = process.env.REPLAY_DUMP;
const waitMs = Number(process.env.REPLAY_WAIT_MS ?? 20000);
const rewrites = JSON.parse(process.env.REPLAY_REWRITE ?? '[]');

const entries = fixture
  ? readFileSync(fixture, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.d === 'in' || e.d === 'out')
      .map((e) => ({ d: e.d, msg: JSON.parse(e.line) }))
  : [];

const dump = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: Object.fromEntries(
    // OPENCODE_CONFIG — какой конфиг сеанса CLI прочтёт (серверы MCP шага, случай strict MCP).
    Object.entries(process.env).filter(([k]) =>
      /^(AGENTDECK_|CODEX_HOME|REPLAY_FIXTURE|OPENCODE_CONFIG$)/.test(k),
    ),
  ),
  stdin: [],
};
const save = () => dumpFile && writeFileSync(dumpFile, JSON.stringify(dump));
save();

const rewrite = (value) => {
  if (typeof value === 'string') {
    return rewrites.reduce((s, [from, to]) => s.split(from).join(to), value);
  }
  if (Array.isArray(value)) return value.map(rewrite);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [rewrite(k), rewrite(v)]));
  }
  return value;
};

const queue = [];
let wake = null;
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let at;
  while ((at = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, at).trim();
    buf = buf.slice(at + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      msg = { unparsed: line };
    }
    dump.stdin.push(msg);
    save();
    queue.push(msg);
    wake?.();
  }
});
process.stdin.on('end', () => process.exit(Number(process.env.REPLAY_EXIT ?? 0)));

const matches = (want, got) =>
  want.method !== undefined
    ? got.method === want.method
    : got.method === undefined && got.id === want.id;

async function take(want) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const at = queue.findIndex((got) => matches(want, got));
    if (at >= 0) return queue.splice(at, 1)[0];
    const left = deadline - Date.now();
    if (left <= 0) {
      process.stderr.write(
        `replay: client never sent ${want.method ?? `reply to ${want.id}`}; got ${JSON.stringify(queue)}\n`,
      );
      process.exit(3);
    }
    await new Promise((done) => {
      wake = done;
      setTimeout(done, left);
    });
    wake = null;
  }
}

const ids = new Map();
for (const entry of entries) {
  if (entry.d === 'out') {
    const msg = rewrite(entry.msg);
    if (msg.method === undefined && ids.has(msg.id)) msg.id = ids.get(msg.id);
    process.stdout.write(`${JSON.stringify(msg)}\n`);
    continue;
  }
  const got = await take(entry.msg);
  if (entry.msg.method !== undefined && entry.msg.id !== undefined) ids.set(entry.msg.id, got.id);
}
// Запись кончилась: CLI ждёт конца stdin, как настоящий.
