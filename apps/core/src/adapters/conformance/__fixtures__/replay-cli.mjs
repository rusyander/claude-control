#!/usr/bin/env node
// Подставной CLI набора соответствия: проигрывает ЗАПИСЬ живого CLI (stream-json, очищенную от
// путей) в ответ на настоящий stdin переходника. Ставится обёрткой под именем CLI (`claude`,
// `qwen`) на PATH пина — переходник идёт тем же путём, что к живому CLI: платформа, хост
// сессии, файлы сеанса, насос. Нужен там, где живого CLI нет (Linux-контейнер, CI).
//
// Окружение:
//   REPLAY_FIXTURE — запись (.jsonl); нет — вывода нет вовсе;
//   REPLAY_DUMP    — сюда JSON: argv, окружение, cwd и все строки stdin (переписывается);
//   REPLAY_STDERR  — текст в stderr при выходе; REPLAY_EXIT — код выхода (по умолчанию 0);
//   REPLAY_EAGER=1 — первый отрезок сразу, не дожидаясь сообщения (ошибка запуска);
//   REPLAY_VERSION — ответ на `--version` (по умолчанию 0.0.0).
//
// Запись режется на отрезки: отрезок кончается строкой `result` и следующими за ней строками
// `command_lifecycle completed`. Отрезок со строкой `system task_notification` — фоновое
// пробуждение: выходит сам следом за предыдущим. Остальные — по одному на сообщение `user`.
// Строка `control_response` записи — ответ CLI на наш управляющий запрос: выходит, когда в
// stdin пришёл запрос с тем же id. После строки `control_request can_use_tool` проигрыш ждёт
// в stdin `control_response` с её id — как живой CLI ждёт ответа о праве.
// Голый node, без типов; пишет только REPLAY_DUMP.
import { readFileSync, writeFileSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';

const env = process.env;
// `--version` — как у живого CLI, одной строкой и выход (версию читает замер базы ядра, G9);
// REPLAY_VERSION — какая версия, по умолчанию 0.0.0. Проигрыш и REPLAY_DUMP не трогаются.
if (process.argv.includes('--version')) {
  writeSync(1, `${env.REPLAY_VERSION ?? '0.0.0'} (replay)\n`);
  process.exit(0);
}
const raw = env.REPLAY_FIXTURE ? readFileSync(env.REPLAY_FIXTURE, 'utf8') : '';
const lines = raw.split('\n').filter((l) => l.trim() !== '');
const parsed = lines.map((l) => JSON.parse(l));

const answers = new Map();
const body = [];
parsed.forEach((value, i) => {
  if (value.type === 'control_response') answers.set(value.response?.request_id, lines[i]);
  else body.push({ value, text: lines[i] });
});

const segments = [];
let current = [];
for (let i = 0; i < body.length; i += 1) {
  current.push(body[i]);
  if (body[i].value.type !== 'result') continue;
  while (
    body[i + 1]?.value.type === 'command_lifecycle' &&
    body[i + 1].value.state === 'completed'
  ) {
    i += 1;
    current.push(body[i]);
  }
  segments.push(current);
  current = [];
}
if (current.length > 0) segments.push(current);
const auto = (segment) =>
  segment.some((e) => e.value.type === 'system' && e.value.subtype === 'task_notification');

const dump = { argv: process.argv.slice(2), env: { ...env }, cwd: process.cwd(), stdin: [] };
const save = () => {
  if (env.REPLAY_DUMP) writeFileSync(env.REPLAY_DUMP, JSON.stringify(dump));
};
save();

const finish = () => {
  if (env.REPLAY_STDERR) writeSync(2, env.REPLAY_STDERR);
  process.exit(Number(env.REPLAY_EXIT ?? 0));
};

const waiting = new Map();
const replies = new Set();
const answered = (id) =>
  replies.has(id) ? Promise.resolve() : new Promise((resolve) => waiting.set(id, resolve));

let next = 0;
let chain = Promise.resolve();
const play = async () => {
  do {
    const segment = segments[next];
    if (!segment) break;
    next += 1;
    for (const entry of segment) {
      writeSync(1, `${entry.text}\n`);
      const v = entry.value;
      if (v.type === 'control_request' && v.request?.subtype === 'can_use_tool') {
        await answered(v.request_id);
      }
    }
  } while (segments[next] && auto(segments[next]));
  if (next >= segments.length && env.REPLAY_EXIT !== undefined) finish();
};
const enqueue = () => {
  chain = chain.then(play);
};

// Забытый тест не оставляет процесс жить часами.
setTimeout(() => process.exit(0), Number(env.REPLAY_MAX_MS ?? 120_000)).unref();

if (env.REPLAY_EAGER === '1' || segments.length === 0) {
  if (segments.length === 0 && env.REPLAY_EXIT !== undefined) finish();
  else enqueue();
}

createInterface({ input: process.stdin })
  .on('line', (text) => {
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      value = { unparsed: text };
    }
    dump.stdin.push(value);
    save();
    if (value.type === 'control_request') {
      const answer = answers.get(value.request_id);
      if (answer) writeSync(1, `${answer}\n`);
    } else if (value.type === 'control_response') {
      const id = value.response?.request_id;
      replies.add(id);
      waiting.get(id)?.();
    } else if (value.type === 'user') {
      enqueue();
    }
  })
  .on('close', () => {
    void chain.then(finish);
  });
