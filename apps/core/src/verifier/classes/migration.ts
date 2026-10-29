import type { Fact } from '@agentdeck/contracts/core/facts';
import type { MigrationFinding, MigrationOutcome } from '@agentdeck/contracts/core/records';
import { execIn, type EngineHandle } from '../../platform/container-engine.ts';

/**
 * Класс проверки `migration` (04:128-129): миграции идут на одноразовом контейнере БД задачи —
 * up (и down, если инструмент его знает), разница схемы записана, разрушающие операторы —
 * находки. Общая или настоящая БД сюда не попадает никогда: исполнитель — `docker exec` в
 * контейнер задачи (P84), запись в общую БД — точка человека 3 (06).
 *
 * Форматы файлов: пара `X.up.sql` / `X.down.sql` (golang-migrate), разделы `-- migrate:up` /
 * `-- migrate:down` (dbmate), `-- +goose Up` / `-- +goose Down` (goose); прочий `.sql` — только up.
 */

export interface MigrationFile {
  path: string; // от корня репозитория, прямые слеши
  text: string;
}

export interface MigrationStep {
  file: string;
  up: string;
  down: string | null;
}

export interface MigrationIo {
  apply(sql: string, file: string): Promise<{ ok: true } | { ok: false; tail: string }>;
  /** Схема БД текстом (`pg_dump --schema-only`); не прочиталась — `unknown`, прогон без вердикта. */
  schema(): Promise<Fact<string>>;
}

function sections(text: string, upRe: RegExp, downRe: RegExp): { up: string; down: string } | null {
  const lines = text.split(/\r?\n/);
  const upAt = lines.findIndex((l) => upRe.test(l));
  if (upAt < 0) return null;
  const downAt = lines.findIndex((l) => downRe.test(l));
  const cut = (from: number, to: number) =>
    lines
      .slice(from + 1, to < 0 ? undefined : to)
      .filter((l) => !/^\s*--\s*\+goose\s+Statement(Begin|End)/i.test(l))
      .join('\n');
  if (downAt < 0) return { up: cut(upAt, -1), down: '' };
  return downAt > upAt
    ? { up: cut(upAt, downAt), down: cut(downAt, -1) }
    : { up: cut(upAt, -1), down: cut(downAt, upAt) };
}

/** Числовая версия в начале имени файла (`10_drop.up.sql` → 10n); без неё — null. */
function versionOf(path: string): bigint | null {
  const m = /^(\d+)/.exec(path.slice(path.lastIndexOf('/') + 1));
  return m ? BigInt(m[1] as string) : null;
}

/** Порядок инструментов: golang-migrate, goose и dbmate разбирают версию числом, не строкой (A2-F13). */
function byVersion(a: MigrationFile, b: MigrationFile): number {
  const va = versionOf(a.path);
  const vb = versionOf(b.path);
  if (va !== null && vb !== null && va !== vb) return va < vb ? -1 : 1;
  if (va !== null && vb === null) return -1;
  if (va === null && vb !== null) return 1;
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

/** Шаги миграции в порядке версий, как их применяют инструменты. */
export function migrationPlan(files: readonly MigrationFile[]): MigrationStep[] {
  const sql = files.filter((f) => f.path.toLowerCase().endsWith('.sql'));
  const byPath = new Map(sql.map((f) => [f.path, f]));
  const steps: MigrationStep[] = [];
  for (const f of [...sql].sort(byVersion)) {
    const lower = f.path.toLowerCase();
    if (lower.endsWith('.down.sql')) continue;
    if (lower.endsWith('.up.sql')) {
      const down = byPath.get(`${f.path.slice(0, -'.up.sql'.length)}.down.sql`);
      steps.push({ file: f.path, up: f.text, down: down ? down.text : null });
      continue;
    }
    const dbmate = sections(f.text, /^\s*--\s*migrate:up/i, /^\s*--\s*migrate:down/i);
    const goose = dbmate ?? sections(f.text, /^\s*--\s*\+goose\s+Up/i, /^\s*--\s*\+goose\s+Down/i);
    if (goose) {
      steps.push({ file: f.path, up: goose.up, down: goose.down.trim() ? goose.down : null });
      continue;
    }
    steps.push({ file: f.path, up: f.text, down: null });
  }
  return steps;
}

const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Операторы SQL сканером, а не регуляркой (B2-F04): строки `'…'` (и `E'…'` с `\`-экранами),
 * идентификаторы `"…"`, комментарии `--` и вложенные блочные понимаются как в Postgres — `--`
 * внутри строки не съедает следующий оператор, слова внутри строк не становятся операторами
 * (строка заменяется на `''`). Тело `$tag$…$tag$` (DO, функции) — код: его операторы сканируются
 * тем же правилом и идут в список рядом с внешним.
 */
function statements(sql: string, depth = 0): string[] {
  const out: string[] = [];
  let cur = '';
  const flush = () => {
    const s = cur.replace(/\s+/g, ' ').trim();
    if (s) out.push(s);
    cur = '';
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] as string;
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
      cur += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      let level = 1;
      i += 2;
      while (i < sql.length && level > 0) {
        const pair = sql.slice(i, i + 2);
        if (pair === '/*') level += 1;
        else if (pair === '*/') level -= 1;
        i += pair === '/*' || pair === '*/' ? 2 : 1;
      }
      cur += ' ';
      continue;
    }
    if (c === "'") {
      const escapes = /(^|[^\w])[eE]$/.test(sql.slice(Math.max(0, i - 2), i));
      i += 1;
      while (i < sql.length) {
        if (escapes && sql[i] === '\\') i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i += 1;
      }
      i += 1;
      cur += "''";
      continue;
    }
    if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      const stop = end < 0 ? sql.length : end + 1;
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '$') {
      const tag = DOLLAR_TAG.exec(sql.slice(i));
      if (tag && !/[\w$]/.test(sql[i - 1] ?? '')) {
        const open = tag[0];
        const end = sql.indexOf(open, i + open.length);
        const body = sql.slice(i + open.length, end < 0 ? sql.length : end);
        if (depth < 4) out.push(...statements(body, depth + 1));
        i = end < 0 ? sql.length : end + open.length;
        cur += "''";
        continue;
      }
    }
    if (c === ';') {
      flush();
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  flush();
  return out;
}

/** Отрезок от `from` до конца его скобки (CTE) или оператора — там ищется WHERE. */
function scopeFrom(statement: string, from: number): string {
  let level = 0;
  for (let i = from; i < statement.length; i += 1) {
    if (statement[i] === '(') level += 1;
    else if (statement[i] === ')') {
      level -= 1;
      if (level < 0) return statement.slice(from, i);
    }
  }
  return statement.slice(from);
}

/** Изменение строк без условия где угодно в операторе: CTE, тело DO, ON CONFLICT не в счёт. */
function unconditioned(statement: string, re: RegExp): boolean {
  for (const m of statement.matchAll(re)) {
    if (!/\bwhere\b/i.test(scopeFrom(statement, m.index ?? 0))) return true;
  }
  return false;
}

const DELETE_FROM = /\bdelete\s+from\b/gi;
const UPDATE_SET =
  /(?<!\bdo\s)\bupdate\s+(only\s+)?(?!set\b)[\w."]+(\s+(as\s+)?(?!set\b)\w+)?\s+set\b/gi;

const DESTRUCTIVE: [RegExp, MigrationFinding['kind']][] = [
  [
    /\bdrop\s+(table|schema|database|column|view|materialized\s+view|type|index|function|procedure|sequence|extension|trigger|domain|aggregate|rule|policy|owned)\b/i,
    'drop',
  ],
  [/\balter\s+table\s+.*\bdrop\s+(column|constraint)?\b/i, 'drop'],
  [/\btruncate\s+(table\s+)?(only\s+)?["\w]/i, 'truncate'],
  [/\balter\s+table\s+.*\balter\s+(column\s+)?\S+\s+(set\s+data\s+)?type\b/i, 'alter-type'],
  [/\balter\s+table\s+.*\brename\b/i, 'other'],
];

/**
 * Разрушающие операторы раздела up (down по смыслу разрушает — его не судим). UPDATE без WHERE —
 * свой вид: под `other` он сливался с переименованием, и отчёт не отличал затёртые строки от
 * сменившегося имени.
 */
export function destructiveFindings(file: string, upSql: string): MigrationFinding[] {
  const out: MigrationFinding[] = [];
  for (const statement of statements(upSql)) {
    const hit = (kind: MigrationFinding['kind']) =>
      out.push({ file, statement: statement.slice(0, 200), kind });
    if (unconditioned(statement, DELETE_FROM)) {
      hit('delete-without-where');
      continue;
    }
    if (unconditioned(statement, UPDATE_SET)) {
      hit('update-without-where');
      continue;
    }
    const found = DESTRUCTIVE.find(([re]) => re.test(statement));
    if (found) hit(found[1]);
  }
  return out;
}

/** Строки схемы без шума дампа (комментарии, SET, служебные команды psql, пустые). */
export function normalizeSchema(dump: string): string[] {
  return dump
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(
      (l) =>
        l.trim() !== '' &&
        !l.startsWith('--') &&
        !l.startsWith('\\') &&
        !/^SET\s/i.test(l) &&
        !/^SELECT pg_catalog\.set_config/i.test(l),
    );
}

function diffLines(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const count = (rows: string[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r, (m.get(r) ?? 0) + 1);
    return m;
  };
  const b = count(before);
  const a = count(after);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [row, n] of a) for (let i = b.get(row) ?? 0; i < n; i += 1) added.push(row);
  for (const [row, n] of b) for (let i = a.get(row) ?? 0; i < n; i += 1) removed.push(row);
  return { added, removed };
}

export async function runMigrations(
  steps: readonly MigrationStep[],
  io: MigrationIo,
): Promise<Fact<MigrationOutcome>> {
  const findings = steps.flatMap((s) => destructiveFindings(s.file, s.up));
  const before = await io.schema();
  if (!('value' in before))
    return { unknown: `schema before: ${'unknown' in before ? before.unknown : 'absent'}` };
  const applied: string[] = [];
  for (const step of steps) {
    const got = await io.apply(step.up, step.file);
    if (!got.ok) {
      return {
        value: {
          applied,
          down: 'not-supported',
          schemaDiff: { added: [], removed: [] },
          findings,
          failed: { file: step.file, tail: got.tail },
        },
      };
    }
    applied.push(step.file);
  }
  const after = await io.schema();
  if (!('value' in after))
    return { unknown: `schema after: ${'unknown' in after ? after.unknown : 'absent'}` };
  const schemaDiff = diffLines(normalizeSchema(before.value), normalizeSchema(after.value));
  let down: MigrationOutcome['down'] = 'not-supported';
  let failed: MigrationOutcome['failed'] = null;
  if (steps.length > 0 && steps.every((s) => s.down !== null)) {
    for (const step of [...steps].reverse()) {
      const got = await io.apply(step.down as string, `${step.file} (down)`);
      if (!got.ok) {
        failed = { file: `${step.file} (down)`, tail: got.tail };
        break;
      }
    }
    if (!failed) {
      const reverted = await io.schema();
      if (!('value' in reverted))
        return {
          unknown: `schema after down: ${'unknown' in reverted ? reverted.unknown : 'absent'}`,
        };
      const back = diffLines(normalizeSchema(before.value), normalizeSchema(reverted.value));
      down = back.added.length === 0 && back.removed.length === 0 ? 'reverted' : 'differs';
    }
  }
  return { value: { applied, down, schemaDiff, findings, failed } };
}

function tail(text: string): string {
  return text.trim().split(/\r?\n/).slice(-20).join('\n');
}

/** Исполнитель Postgres: `psql` и `pg_dump` ВНУТРИ контейнера задачи — дороги к другой БД нет. */
export function postgresIo(
  h: EngineHandle,
  containerId: string,
  login: { user: string; db: string },
): MigrationIo {
  return {
    async apply(sql) {
      const got = await execIn(
        h,
        containerId,
        ['psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', login.user, '-d', login.db, '-f', '-'],
        { input: sql, timeoutMs: 300_000 },
      );
      if ('error' in got) return { ok: false, tail: got.error };
      return got.code === 0 ? { ok: true } : { ok: false, tail: tail(got.stderr || got.stdout) };
    },
    async schema() {
      const got = await execIn(
        h,
        containerId,
        ['pg_dump', '--schema-only', '--no-owner', '--no-privileges', '-U', login.user, login.db],
        { timeoutMs: 120_000 },
      );
      if ('error' in got) return { unknown: got.error };
      if (got.code !== 0) return { unknown: `pg_dump exit ${got.code}: ${tail(got.stderr)}` };
      return { value: got.stdout };
    },
  };
}
