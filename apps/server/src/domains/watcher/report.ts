import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { WatchEntryClass, WatchSeverity, WatchVerdict } from '@agentdeck/contracts';
import { readTextFile, writeTextFile } from '../../lib/safe-io.ts';
import { maskSecretsInText } from '../../lib/secret-mask.ts';
import { refNumber, type ReportRefs } from './events.ts';
import {
  LOCATION_LINE,
  REPORT_TEXTS,
  type ReportLanguage,
  type ReportTexts,
} from './report-texts.ts';
import type { WatchEvent } from './types.ts';

/**
 * Отчёт наблюдателя — `WATCH-REPORT.md` в корне приложения.
 *
 * Читает его человек или ДРУГОЙ агент, который будет чинить, — и читает
 * холодным, без этой панели под рукой. Поэтому каждый раздел самодостаточен:
 * тип (сбой или замечание), важность, статус сверки с кодом, место
 * `файл:строка`, причина, шаги воспроизведения, как исправить, улики как были
 * (секреты замаскированы) и сколько раз встречалось. Сверху — оглавление
 * таблицей, по нему видно всё сразу. Номер `WR-n` устойчив: «исправлено
 * WR-12» однозначно и через неделю.
 *
 * Корень берётся от места установки сервера, а не от `process.cwd()`: панель
 * запускают и из корня, и из `apps/server`, и сторожем из другого каталога, а
 * человеку нужен один файл в одном месте. Переменная окружения
 * `AGENTDECK_WATCH_REPORT` переносит отчёт — только для проверок, которые
 * поднимают одноразовую панель из тех же исходников и не должны писать в
 * настоящий отчёт.
 *
 * Файл ОБНОВЛЯЕТСЯ, а не переписывается: у каждого раздела устойчивый id
 * (отпечаток причины) в паре комментариев-меток, повтор меняет ровно свой
 * раздел, всё остальное — включая приписки человека вне меток — остаётся байт
 * в байт. Каждый текст перед записью проходит маскировку секретов: отчёт
 * пересылают.
 */

export const WATCH_REPORT_NAME = 'WATCH-REPORT.md';
export const WATCH_REPORT_ENV = 'AGENTDECK_WATCH_REPORT';

/** Корень приложения: `apps/server/src/domains/watcher/` → пять уровней вверх. */
export function appRootDir(): string {
  return fileURLToPath(new URL('../../../../../', import.meta.url));
}

export function watchReportPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[WATCH_REPORT_ENV]?.trim();
  return override || join(appRootDir(), WATCH_REPORT_NAME);
}

/** Отчёт не записался — причина для человека, а наблюдатель живёт дальше. */
export class WatchReportError extends Error {
  readonly path: string;
  /** Причина файловой системы как есть (`EACCES: permission denied…`). */
  readonly reason: string;
  constructor(path: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`${path}: ${reason}`);
    this.name = 'WatchReportError';
    this.path = path;
    this.reason = reason;
  }
}

const HEADER_OPEN = '<!-- watch:header -->';
const HEADER_CLOSE = '<!-- /watch:header -->';
const SEVERITY_RANK: Record<WatchSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Сколько строк стека в уликах: дальше — рамки фреймворка, причины там нет. */
const STACK_LINES = 30;
/** Сколько последних строк stderr в уликах: причина провайдера — в конце вывода. */
const OUTPUT_LINES = 30;

/** Текст извне не должен уметь закрыть или подделать метку раздела. */
function safe(text: string): string {
  return maskSecretsInText(text).replace(/<!--/g, '<!—').replace(/-->/g, '—>');
}

/** Одна строка для таблицы: без переводов строк и вертикальных черт. */
function cell(text: string): string {
  return safe(text).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

function fence(text: string): string {
  const body = safe(text).replace(/```/g, "'''");
  return ['```text', body, '```'].join('\n');
}

function verdictOf(event: WatchEvent): WatchVerdict {
  if (event.entryClass === 'remark') return 'confirmed';
  return event.finding?.verdict ?? 'pending';
}

function titleOf(event: WatchEvent): string {
  const raw = event.remark?.title || event.finding?.title || event.message.split('\n')[0] || '';
  return raw.slice(0, 160);
}

function locationOf(event: WatchEvent): string | undefined {
  return event.remark?.location || event.finding?.location || undefined;
}

function evidence(event: WatchEvent, t: ReportTexts): string[] {
  const lines = [`### ${t.evidence}`, '', fence(event.message), ''];
  if (event.stack) {
    const stack = event.stack.split('\n').slice(0, STACK_LINES).join('\n');
    lines.push(t.stack, '', fence(stack), '');
  }
  if (event.output) {
    const tail = event.output.split('\n').slice(-OUTPUT_LINES).join('\n');
    lines.push(t.output, '', fence(tail), '');
  }
  return lines;
}

function failureBody(event: WatchEvent, t: ReportTexts): string[] {
  const finding = event.finding;
  const lines: string[] = [];
  lines.push(
    `### ${t.happened}`,
    '',
    finding?.happened ? safe(finding.happened) : safe(event.message.split('\n')[0] ?? ''),
    '',
  );
  if (finding?.rootCause) lines.push(`### ${t.rootCause}`, '', safe(finding.rootCause), '');
  const steps = finding?.steps || finding?.context;
  if (steps) lines.push(`### ${t.steps}`, '', safe(steps), '');
  if (finding?.fix) lines.push(`### ${t.fix}`, '', safe(finding.fix), '');
  lines.push(...evidence(event, t));
  if (!finding) lines.push(t.notChecked, '');
  return lines;
}

function remarkBody(event: WatchEvent, t: ReportTexts): string[] {
  const remark = event.remark;
  const lines = [`### ${t.wrong}`, '', safe(remark?.explanation || event.message), ''];
  if (remark?.fix) lines.push(`### ${t.fix}`, '', safe(remark.fix), '');
  if (remark?.relatedTo) {
    lines.push(t.noticedIn(safe(remark.relatedTo)), '');
  }
  return lines;
}

/** Раздел одной причины вместе с метками. */
export function renderSection(event: WatchEvent, lang: ReportLanguage = 'ru'): string {
  const t = REPORT_TEXTS[lang];
  const verdict = verdictOf(event);
  const location = locationOf(event);
  const where = [event.method, event.path].filter(Boolean).join(' ');
  const ref = event.ref || event.id;
  const attrs = [
    `ref=${ref}`,
    `class=${event.entryClass}`,
    `severity=${event.severity}`,
    `verdict=${verdict}`,
    `count=${event.count}`,
    `first=${event.firstSeen}`,
    `last=${event.lastSeen}`,
  ].join(' ');
  const lines = [
    `<!-- watch:${event.id} ${attrs} -->`,
    `## ${ref} · ${safe(titleOf(event))}`,
    '',
    `- **${t.type}:** ${t.entryClass[event.entryClass]} — ${t.kind[event.kind] ?? event.kind} (${t.source[event.source] ?? event.source})`,
    `- **${t.importance}:** ${t.severity[event.severity]}`,
    `- **${t.status}:** ${t.verdict[verdict]}`,
    `- **${t.location}:** ${location ? `\`${safe(location)}\`` : '—'}`,
    ...(where
      ? [`- **${t.request}:** \`${safe(where)}\`${event.status ? ` → ${event.status}` : ''}`]
      : []),
    ...(event.durationMs !== undefined
      ? [`- **${t.duration((event.durationMs / 1000).toFixed(1))}`]
      : []),
    ...(event.route ? [`- **${t.route}:** \`${safe(event.route)}\``] : []),
    `- **${t.repeats}:** ${event.count} · **${t.firstSeen}:** ${event.firstSeen} · **${t.lastSeen}:** ${event.lastSeen}`,
    ...(event.merged?.length ? [`- **${t.merged}:** ${event.merged.join(', ')}`] : []),
    `- **${t.fingerprint}:** \`${event.id}\``,
    '',
    ...(event.entryClass === 'remark' ? remarkBody(event, t) : failureBody(event, t)),
    `<!-- /watch:${event.id} -->`,
  ];
  return lines.join('\n');
}

export interface SectionMeta {
  ref: string;
  entryClass: WatchEntryClass;
  severity: WatchSeverity;
  verdict: WatchVerdict;
  count: number;
  first: string;
  last: string;
  title: string;
  location?: string;
}

const OPEN_MARK = /<!-- watch:([0-9a-f]{6,40})((?: [a-z]+=\S+)+) -->/g;

function attrsOf(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.trim().split(' ')) {
    const at = pair.indexOf('=');
    if (at > 0) out[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return out;
}

export function sectionsOf(text: string): Map<string, SectionMeta> {
  const found = new Map<string, SectionMeta>();
  for (const match of text.matchAll(OPEN_MARK)) {
    const id = match[1]!;
    const attrs = attrsOf(match[2] ?? '');
    const start = (match.index ?? 0) + match[0].length;
    const end = text.indexOf(`<!-- /watch:${id} -->`, start);
    const body = text.slice(start, end < 0 ? undefined : end);
    const heading = /^## (.*)$/m.exec(body)?.[1] ?? '';
    const location = LOCATION_LINE.exec(body)?.[1];
    const ref = attrs.ref ?? id;
    found.set(id, {
      ref,
      entryClass: attrs.class === 'remark' ? 'remark' : 'failure',
      severity:
        (attrs.severity as WatchSeverity) in SEVERITY_RANK
          ? (attrs.severity as WatchSeverity)
          : 'medium',
      verdict: (attrs.verdict as WatchVerdict) ?? 'pending',
      count: Number(attrs.count ?? 0),
      first: attrs.first ?? '',
      last: attrs.last ?? '',
      title: heading.startsWith(`${ref} · `) ? heading.slice(ref.length + 3) : heading,
      ...(location ? { location } : {}),
    });
  }
  return found;
}

function renderHeader(text: string, t: ReportTexts): string {
  const sections = [...sectionsOf(text).values()];
  const failures = sections.filter((s) => s.entryClass === 'failure');
  const remarks = sections.length - failures.length;
  const by = (verdict: WatchVerdict) => failures.filter((s) => s.verdict === verdict).length;
  const first = sections.map((s) => s.first).sort()[0];
  const last = sections
    .map((s) => s.last)
    .sort()
    .at(-1);
  const repeats = sections.reduce((sum, s) => sum + s.count, 0);
  const ordered = [...sections].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || refNumber(a.ref) - refNumber(b.ref),
  );
  const index =
    ordered.length === 0
      ? []
      : [
          '',
          `## ${t.index}`,
          '',
          t.indexHead,
          '|---|---|---|---|---|---|---|',
          ...ordered.map(
            (s) =>
              `| ${s.ref} | ${t.entryClass[s.entryClass]} | ${t.severity[s.severity]} | ${s.entryClass === 'remark' ? t.byCode : t.shortVerdict[s.verdict]} | ${s.count} | ${s.location ? `\`${cell(s.location)}\`` : '—'} | ${cell(s.title)} |`,
          ),
        ];
  return [
    HEADER_OPEN,
    `- **${t.sections(sections.length, failures.length, { confirmed: by('confirmed'), 'not-in-code': by('not-in-code'), unclear: by('unclear'), pending: by('pending') }, remarks)}`,
    `- **${t.cases}:** ${repeats}`,
    `- **${t.firstRecord}:** ${first ?? '—'} · **${t.lastRecord}:** ${last ?? '—'}`,
    ...index,
    HEADER_CLOSE,
  ].join('\n');
}

function replaceBlock(
  text: string,
  open: RegExp,
  close: string,
  block: string,
): string | undefined {
  const start = text.search(open);
  if (start < 0) return undefined;
  const end = text.indexOf(close, start);
  if (end < 0) return undefined;
  return text.slice(0, start) + block + text.slice(end + close.length);
}

/**
 * Текст отчёта после вставки, замены и снятия разделов. Чистая функция — её и
 * проверяют. `removed` — отпечатки разделов, которые модель влила в другие.
 * `lang` — язык интерфейса панели: на нём пишутся шапка и заново выводимые
 * разделы; разделы, которых пачка не касалась, остаются как были.
 */
export function upsertSections(
  previous: string,
  events: readonly WatchEvent[],
  removed: readonly string[] = [],
  lang: ReportLanguage = 'ru',
): string {
  const t = REPORT_TEXTS[lang];
  let text = previous.trim()
    ? previous
    : `${t.title}\n\n${t.intro.join('\n')}\n\n${HEADER_OPEN}\n${HEADER_CLOSE}\n`;
  for (const id of removed) {
    const open = new RegExp(`\\n*<!-- watch:${id} [^\\n]*-->`);
    text = replaceBlock(text, open, `<!-- /watch:${id} -->`, '') ?? text;
  }
  for (const event of events) {
    const block = renderSection(event, lang);
    const open = new RegExp(`<!-- watch:${event.id} [^\\n]*-->`);
    const replaced = replaceBlock(text, open, `<!-- /watch:${event.id} -->`, block);
    text = replaced ?? `${text.replace(/\s*$/, '')}\n\n${block}\n`;
  }
  const withHeader = replaceBlock(
    text,
    /<!-- watch:header -->/,
    HEADER_CLOSE,
    renderHeader(text, t),
  );
  // Метки шапки человек мог стереть — тогда шапка встаёт заново под заголовком.
  // Замена — функцией: в шапке заголовки сбоев, и `$'`/`$&` из текста ошибки
  // строкой-заменой раскрылись бы в куски самого отчёта.
  return withHeader ?? text.replace(/\n/, () => `\n\n${renderHeader(text, t)}\n`);
}

const LOCK_WAIT_MS = 3000;
/**
 * Короче ожидания: запись отчёта держит замок миллисекунды, а замок старше
 * ожидания держал бы каждый сигнал все 3 с на главном потоке и ронял его.
 */
const LOCK_STALE_MS = 2000;

/** Жив ли процесс, названный в замке. `EPERM` — есть, но чужой: тоже жив. */
function ownerAlive(lock: string): boolean {
  const pid = Number(readFileSync(lock, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Замок на время чтения-правки-записи: отчёт могут писать два процесса панели
 * (стенд и одноразовая проверка с тем же путём), и без замка второй затёр бы
 * раздел, дописанный первым между его чтением и записью. Замок называет pid
 * владельца: умершего посреди записи снимаем сразу, безымянный — по возрасту.
 */
function withLock<T>(path: string, work: () => T): T {
  const lock = `${path}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(lock, 'wx');
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
        if (stale || !ownerAlive(lock)) rmSync(lock, { force: true });
      } catch {
        // Замок сняли между проверкой и чтением — следующая попытка его возьмёт.
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return work();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Вписать разделы в отчёт на диске. Не вышло — `WatchReportError` с путём и причиной. */
export function writeReportSections(
  path: string,
  events: readonly WatchEvent[],
  removed: readonly string[] = [],
  lang: ReportLanguage = 'ru',
): void {
  if (events.length === 0 && removed.length === 0) return;
  try {
    // Папки отчёта может не быть (перенесённый путь): создаём, иначе первая
    // находка упала бы на файле блокировки и отчёт так и не появился бы.
    mkdirSync(dirname(path), { recursive: true });
    withLock(path, () => {
      const previous = existsSync(path) ? readTextFile(path) : '';
      writeTextFile(path, upsertSections(previous, events, removed, lang));
    });
  } catch (error) {
    throw new WatchReportError(path, error);
  }
}

function readSections(path: string): Map<string, SectionMeta> {
  try {
    return existsSync(path) ? sectionsOf(readTextFile(path)) : new Map();
  } catch {
    return new Map();
  }
}

/** Сколько разделов в отчёте на диске и сколько из них замечаний (для статуса). */
export function reportCounts(path: string): { findings: number; remarks: number } {
  const sections = [...readSections(path).values()];
  return {
    findings: sections.length,
    remarks: sections.filter((s) => s.entryClass === 'remark').length,
  };
}

/** Номера разделов, уже лежащих в отчёте: у причины номер не меняется. */
export function reportRefs(path: () => string): ReportRefs {
  return {
    refOf: (id) => readSections(path()).get(id)?.ref,
    maxRef: () => Math.max(0, ...[...readSections(path()).values()].map((s) => refNumber(s.ref))),
  };
}
