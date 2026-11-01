import { statSync } from 'node:fs';
import type { Fact } from '@agentdeck/contracts/core/facts';
import {
  CONFIG_SECTION_SCHEMAS,
  CONFIG_SECTIONS,
  grantRequiredSectionSchema,
  queueSectionSchema,
  type ConfigSection,
  type ConfigView,
  type CoreConfig,
} from '@agentdeck/contracts/core/config';
import type { CoreHomeLayout } from '../core-home.ts';
import { readBytesSync } from '../safe-io/files.ts';
import {
  ABSENT_FILE,
  canonicalJson,
  configFilesOf,
  NO_CONFIG_DIGEST,
  sha256Hex,
  type ConfigFiles,
} from './files.ts';
import { readConfigState } from './state.ts';

/**
 * ЕДИНСТВЕННЫЙ читатель `config.json` дома ядра (00:58, этап 7). Каждый раздел судится своей
 * схемой из контрактов отдельно: негодный раздел не попадает в документ и назван в `issues`,
 * годные действуют — один кривой раздел не гасит остальные. Неизвестный ключ — тоже жалоба
 * (документ строгий). Файла нет — `absent`; не читается, не JSON, не объект — `unknown`.
 *
 * Два раздела спасаются по частям, как судили их прежние разборщики: `grantRequired` — по
 * строкам (строка маски защищает; одна кривая строка не снимает защиту остальных), `queue` — по
 * полям (негодное поле берёт прежнее хорошее значение у читателя очереди, A1r3-F07). Жалоба
 * такой части начинается с её имени: `3: …` у строки, `slots: …` у поля.
 *
 * Дрейф (G6): ядро помнит отпечаток своей последней записи (`config.state.json`). Файл с другим
 * отпечатком правлен мимо API — он НЕ действует: действует `config.last.json` (копия последней
 * записи ядра), дрейф назван в `drift`. Запись в полёте с отпечатком файла — восстановление после
 * краха, не дрейф. Памяти писателя нет — файл до этапа 7 (или ядро ещё не писало): действует сам
 * файл, как раньше; принимает его один раз загрузка (`bootstrap/core-config`).
 */

const SECTIONS: ReadonlySet<string> = new Set(CONFIG_SECTIONS);

export const QUEUE_FIELDS = ['slots', 'shareCap', 'agingMs', 'beatMs'] as const;
export type QueueField = (typeof QUEUE_FIELDS)[number];

type ZodIssues = { issues: readonly { path: PropertyKey[]; message: string }[] };

function reasonOf(error: ZodIssues): string {
  if (error.issues.length === 0) return 'rejected';
  // Все поля, а не первое: отказ загрузки (раздел `routes`) называет каждое негодное поле.
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const at = issue.path.map(String).join('.');
      return at ? `${at}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Раздел целиком или по частям: годное — в документ, прочее — жалобами. */
function judgeSection(
  section: ConfigSection,
  value: unknown,
): { data?: unknown; issues: string[] } {
  const whole = CONFIG_SECTION_SCHEMAS[section].safeParse(value);
  if (whole.success) return { data: whole.data, issues: [] };
  if (section === 'grantRequired' && Array.isArray(value)) {
    const rows: unknown[] = [];
    const issues: string[] = [];
    value.forEach((row, i) => {
      const one = grantRequiredSectionSchema.element.safeParse(row);
      if (one.success) rows.push(one.data);
      else issues.push(`${i}: ${reasonOf(one.error)}`);
    });
    return { data: rows, issues };
  }
  if (section === 'queue' && isObject(value)) {
    const kept: Record<string, unknown> = { ...value };
    const issues: string[] = [];
    for (const field of QUEUE_FIELDS) {
      if (kept[field] === undefined) continue;
      const one = queueSectionSchema.shape[field].safeParse(kept[field]);
      if (one.success) continue;
      // Строка жалобы — та, что читатель очереди называл всегда (одна на поле, без текста zod).
      issues.push(`${field}: ${JSON.stringify(kept[field])} rejected`);
      delete kept[field];
    }
    return { data: queueSectionSchema.parse(kept), issues };
  }
  return { issues: [reasonOf(whole.error)] };
}

/** Разбор текста файла: годные разделы — в документ, прочие — жалобой с причиной. */
export function parseCoreConfig(text: string): Fact<ConfigView> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { unknown: `config.json not JSON: ${(error as Error).message}` };
  }
  if (!isObject(raw)) return { unknown: 'config.json: not an object' };
  const doc: Record<string, unknown> = {};
  const issues: ConfigView['issues'] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'v') {
      if (value === 1) doc.v = 1;
      else issues.push({ section: 'v', reason: `unknown version ${JSON.stringify(value)}` });
      continue;
    }
    if (!SECTIONS.has(key)) {
      issues.push({ section: key, reason: 'unknown section' });
      continue;
    }
    const judged = judgeSection(key as ConfigSection, value);
    if (judged.data !== undefined) doc[key] = judged.data;
    for (const reason of judged.issues) issues.push({ section: key, reason });
  }
  return {
    value: { doc: doc as CoreConfig, digest: sha256Hex(text), drift: null, issues },
  };
}

// ── дрейф ────────────────────────────────────────────────────────────────────────────────

type DriftWatcher = (view: ConfigView) => void;
const watchers = new Map<string, Set<DriftWatcher>>();

/**
 * Подписка на дрейф, который увидел ЛЮБОЙ читатель (очередь на каждом проходе, дорога сессии,
 * опрос форжа): заметку в журнал ядра пишет порт настройки, один раз на отпечаток файла.
 */
export function watchConfigDrift(
  where: Pick<CoreHomeLayout, 'config'>,
  watcher: DriftWatcher,
): () => void {
  const key = configFilesOf(where).config;
  const set = watchers.get(key) ?? new Set<DriftWatcher>();
  set.add(watcher);
  watchers.set(key, set);
  return () => {
    set.delete(watcher);
    if (set.size === 0) watchers.delete(key);
  };
}

function tellDrift(files: ConfigFiles, view: ConfigView): void {
  for (const watcher of watchers.get(files.config) ?? []) {
    try {
      watcher(view);
    } catch {
      // Заметка — не решение: сбой подписчика не роняет читателя настройки.
    }
  }
}

function mtimeOf(path: string): number {
  return statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0;
}

/** Какие разделы файл меняет относительно последней записи ядра; не разобрать — `*`. */
function changedSections(fileText: string | undefined, lastText: string): string[] {
  if (fileText === undefined) return ['*'];
  let file: unknown;
  try {
    file = JSON.parse(fileText);
  } catch {
    return ['*'];
  }
  const last = JSON.parse(lastText) as Record<string, unknown>;
  if (!isObject(file)) return ['*'];
  const keys = new Set([...Object.keys(file), ...Object.keys(last)]);
  // `v` — не раздел: файл без него читается версией 1 (документ до этапа 7).
  keys.delete('v');
  return [...keys].filter((k) => canonicalJson(file[k]) !== canonicalJson(last[k])).sort();
}

/** Последняя запись ядра; её копия не та или пропала — `unknown` (ничего не действует молча). */
function lastWrite(
  files: ConfigFiles,
  own: string,
): { view: ConfigView; text: string } | { unknown: string } {
  if (own === NO_CONFIG_DIGEST) {
    return { view: { doc: {}, digest: own, drift: null, issues: [] }, text: '{}' };
  }
  const last = readBytesSync(files.last);
  if (!('value' in last)) {
    return { unknown: 'config.json drifted and config.last.json is not readable' };
  }
  const text = last.value.toString('utf8');
  if (sha256Hex(text) !== own) {
    return { unknown: 'config.json drifted and config.last.json is not the last core write' };
  }
  const parsed = parseCoreConfig(text);
  if (!('value' in parsed)) {
    return { unknown: `config.last.json: ${'unknown' in parsed ? parsed.unknown : 'empty'}` };
  }
  return { view: parsed.value, text };
}

export function readCoreConfig(where: Pick<CoreHomeLayout, 'config'>): Fact<ConfigView> {
  const files = configFilesOf(where);
  const state = readConfigState(files.state);
  if ('unknown' in state) return state;
  const bytes = readBytesSync(files.config);
  if ('unknown' in bytes) return { unknown: `config.json unreadable: ${bytes.unknown}` };
  if ('absent' in state) {
    if ('absent' in bytes) return { absent: true };
    return parseCoreConfig(bytes.value.toString('utf8'));
  }
  const fileText = 'value' in bytes ? bytes.value.toString('utf8') : undefined;
  const fileDigest = fileText === undefined ? ABSENT_FILE : sha256Hex(fileText);
  const own = state.value.digest;
  if (
    fileText !== undefined &&
    (fileDigest === own || fileDigest === state.value.pending?.digest)
  ) {
    return parseCoreConfig(fileText);
  }
  // Первая запись ядра упала до самого файла: настройки по-прежнему нет.
  if (fileText === undefined && own === NO_CONFIG_DIGEST) return { absent: true };
  // Файл правлен (или удалён) мимо API: действует последняя запись ядра, не файл.
  const last = lastWrite(files, own);
  if ('unknown' in last) return last;
  const view: ConfigView = {
    ...last.view,
    drift: {
      fileDigest,
      sections: changedSections(fileText, last.text),
      at: mtimeOf(fileText === undefined ? files.state : files.config),
    },
  };
  tellDrift(files, view);
  return { value: view };
}

// ── помощники читателей разделов ─────────────────────────────────────────────────────────

/** Жалобы раздела одной строкой `<раздел>: …`; жалоб нет — `undefined`. */
export function sectionProblem(view: ConfigView, section: ConfigSection): string | undefined {
  const reasons = view.issues.filter((i) => i.section === section).map((i) => i.reason);
  return reasons.length === 0 ? undefined : `${section}: ${reasons.join('; ')}`;
}

/** Поля `queue`, отвергнутые схемой; раздел отвергнут целиком — `all`. */
export function queueRejected(view: ConfigView): 'all' | Set<QueueField> {
  const fields = new Set<QueueField>();
  for (const issue of view.issues) {
    if (issue.section !== 'queue') continue;
    const field = QUEUE_FIELDS.find((f) => issue.reason.startsWith(`${f}: `));
    if (!field) return 'all';
    fields.add(field);
  }
  return fields;
}
