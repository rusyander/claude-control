#!/usr/bin/env node
/**
 * Экономический оракул P14 (план s5 G6): из ЛОКАЛЬНЫХ транскриптов Claude Code — только числа.
 * Читает `<root>/<project>/<session>.jsonl` (только чтение; подагенты и боковые ветки пропущены),
 * пишет `apps/core/src/economy/__fixtures__/econ/econ.json`. В файл не попадает ни текст, ни id,
 * ни путь, ни имя модели: репозиторий публичный.
 *
 * Строки фикстуры:
 * - `resumes`: точка возврата в сессию после простоя ≥ 2 мин —
 *   [простой с, контекст прошлого хода, часовой срок кэша прошлой записи 0/1,
 *    контекст хода, вход, чтение кэша, запись кэша, часовая запись];
 * - `fresh`: начало сессии, дошедшей до правки файла — [ходов до первой правки,
 *   вход, чтение, запись, часовая запись первого хода, те же четыре суммой по ходам до правки].
 *
 * Запуск: `node tools/econ-extract.mjs [--root <dir>] [--out <file>]`.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const ROOT = resolve(opt('--root', join(homedir(), '.claude', 'projects')));
const OUT = resolve(
  opt(
    '--out',
    join(HERE, '..', 'apps', 'core', 'src', 'economy', '__fixtures__', 'econ', 'econ.json'),
  ),
);

/** Простой, после которого ход считается возвратом в сессию (решение «продолжить или заново»). */
const RESUME_GAP_S = 120;
const CAP_RESUMES = 800;
const CAP_FRESH = 400;
/** Инструменты правки файла: ориентация нового сеанса — ходы до первой правки. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function turnsOf(file) {
  const byId = new Map();
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw.includes('"assistant"')) continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (line.type !== 'assistant' || line.isSidechain) continue;
    const m = line.message;
    const u = m?.usage;
    if (!u || typeof m.id !== 'string') continue;
    const at = Date.parse(line.timestamp);
    if (!Number.isFinite(at)) continue;
    const prev = byId.get(m.id);
    const w1h = num(u.cache_creation?.ephemeral_1h_input_tokens);
    const t = prev ?? { at, input: 0, read: 0, write: 0, w1h: 0, edit: false };
    // Строки одного сообщения несут одну и ту же сводку по частям: берётся максимум полей.
    t.at = Math.min(t.at, at);
    t.input = Math.max(t.input, num(u.input_tokens));
    t.read = Math.max(t.read, num(u.cache_read_input_tokens));
    t.write = Math.max(t.write, num(u.cache_creation_input_tokens));
    t.w1h = Math.max(t.w1h, w1h);
    for (const c of Array.isArray(m.content) ? m.content : [])
      if (c?.type === 'tool_use' && EDIT_TOOLS.has(c.name)) t.edit = true;
    byId.set(m.id, t);
  }
  return [...byId.values()].sort((a, b) => a.at - b.at);
}

const ctxOf = (t) => t.input + t.read + t.write;

function sessionFiles() {
  const out = [];
  for (const project of readdirSync(ROOT).sort()) {
    const dir = join(ROOT, project);
    let names;
    try {
      if (!statSync(dir).isDirectory()) continue;
      names = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const name of names) if (name.endsWith('.jsonl')) out.push(join(dir, name));
  }
  return out;
}

const resumes = [];
const fresh = [];
let sessions = 0;
for (const file of sessionFiles()) {
  let turns;
  try {
    turns = turnsOf(file);
  } catch {
    continue;
  }
  if (turns.length < 2) continue;
  sessions += 1;
  const editAt = turns.findIndex((t) => t.edit);
  if (editAt >= 1) {
    const before = turns.slice(0, editAt);
    const sum = (k) => before.reduce((s, t) => s + t[k], 0);
    const t1 = turns[0];
    fresh.push([
      editAt,
      t1.input,
      t1.read,
      t1.write,
      t1.w1h,
      sum('input'),
      sum('read'),
      sum('write'),
      sum('w1h'),
    ]);
  }
  let ttlLong = 0;
  for (let i = 1; i < turns.length; i += 1) {
    const prev = turns[i - 1];
    if (prev.write > 0) ttlLong = prev.w1h > 0 ? 1 : 0;
    const t = turns[i];
    const gap = Math.round((t.at - prev.at) / 1000);
    const prevCtx = ctxOf(prev);
    // Сжатие или очистка окна между ходами — это не возврат в ту же сессию.
    if (gap < RESUME_GAP_S || prevCtx === 0 || ctxOf(t) < 0.8 * prevCtx) continue;
    resumes.push([gap, prevCtx, ttlLong, ctxOf(t), t.input, t.read, t.write, t.w1h]);
  }
}

/** Детерминированное прореживание: каждый k-й, без случайности. */
const thin = (rows, cap) => {
  if (rows.length <= cap) return rows;
  const step = rows.length / cap;
  return Array.from({ length: cap }, (_, i) => rows[Math.floor(i * step)]);
};

const out = {
  version: 1,
  note: 'numbers only, extracted by tools/econ-extract.mjs from local transcripts',
  sessions,
  resumeGapS: RESUME_GAP_S,
  resumes: thin(resumes, CAP_RESUMES),
  fresh: thin(fresh, CAP_FRESH),
};
/** Строка на образец — ровно как её печатает prettier (проверка формата в pre-commit и CI). */
const rows = (list) => `[\n${list.map((r) => `    [${r.join(', ')}]`).join(',\n')}\n  ]`;
const head = Object.entries(out)
  .filter(([k]) => k !== 'resumes' && k !== 'fresh')
  .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
const text = `{\n${[...head, `  "resumes": ${rows(out.resumes)}`, `  "fresh": ${rows(out.fresh)}`].join(',\n')}\n}\n`;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, text);
console.log(
  `econ: ${sessions} sessions, ${resumes.length} resumes (kept ${out.resumes.length}), ${fresh.length} fresh (kept ${out.fresh.length}) -> ${OUT}`,
);
