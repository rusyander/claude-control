import { join } from 'node:path';
import type { WatchSeverity } from '@agentdeck/contracts';
import { readJsonFile, writeJsonFile } from '../../lib/safe-io/safe-io.ts';
import { maskSecretsInText } from '../../lib/secret-mask/secret-mask.ts';
import { fingerprintOf, remarkFingerprint } from './fingerprint.ts';
import type { WatchEvent, WatchFinding, WatchRemark, WatchSignal } from './types.ts';

/**
 * Кольцо сбоев на диске панели (`<appData>/watcher-events.json`).
 *
 * Кольцо, а не журнал: наблюдатель может простоять включённым неделю, и
 * повторяющийся сбой не должен раздувать файл — одна причина склеивается по
 * отпечатку (растёт счётчик), а сверх потолка уходят самые давние. Секреты
 * маскируются ДО записи: файл лежит на диске и уезжает в промпт модели.
 *
 * Номер `WR-n` раздаётся здесь: сначала спрашиваем отчёт (раздел этой причины
 * там уже есть — номер его), иначе следующий после самого большого из отчёта
 * и кольца. Так номер не меняется ни после перезапуска, ни после
 * выключения-включения, и два разных раздела никогда не делят один номер.
 * Влитый моделью раздел оставляет псевдоним: его новый повтор идёт в раздел,
 * куда его влили.
 */

export const WATCH_EVENTS_FILE = 'watcher-events.json';
/** Сколько разных сбоев держим. Больше — модель всё равно не разберёт за раз. */
export const WATCH_EVENTS_MAX = 200;
/**
 * Не позже чем через столько после первой правки кольцо уходит на диск. Полное
 * кольцо — полмегабайта JSON, и чтение с перезаписью на каждый сигнал стоили
 * 6,4 мс синхронно (лавина 5xx из сотни запросов — полсекунды стоящего сервера).
 * Окно отсчитывается от ПЕРВОЙ правки, а не от последней: поток сигналов не
 * откладывает запись бесконечно. На выходе панели запись — сразу (`flush`).
 */
export const WATCH_EVENTS_FLUSH_MS = 250;
/** Потолки полей: стек в тысячу строк модели не нужен, хватит начала. */
const MESSAGE_MAX = 2000;
const STACK_MAX = 4000;
const REF_PREFIX = 'WR-';

/** Важность до разбора — по виду сигнала; модель потом может её поправить. */
const DEFAULT_SEVERITY: Record<WatchEvent['kind'], WatchSeverity> = {
  'process-crash': 'critical',
  'render-crash': 'high',
  'http-5xx': 'high',
  'window-error': 'medium',
  'unhandled-rejection': 'medium',
  'api-failure': 'medium',
  'log-error': 'medium',
  'spawn-failed': 'medium',
  'cli-exit': 'medium',
  'console-error': 'medium',
  'http-4xx': 'medium',
  'contract-mismatch': 'medium',
  'stuck-loading': 'medium',
  'slow-request': 'low',
  'log-warn': 'low',
  'console-warn': 'low',
  remark: 'low',
  'user-report': 'medium',
};

interface EventsFile {
  events: WatchEvent[];
  /** Влитый отпечаток → раздел, куда влит. */
  aliases?: Record<string, string>;
  /** Самый большой выданный номер. */
  lastRef?: number;
}

export interface RecordResult {
  event: WatchEvent;
  isNew: boolean;
  /**
   * Запись осталась в кольце. Новый сбой со старым `at` на потолке вытесняется в
   * том же вызове — раздел отчёта о нём остался бы без записи и без разбора.
   */
  kept: boolean;
}

/** Что отчёт знает о номерах: номер раздела по отпечатку и самый большой номер. */
export interface ReportRefs {
  refOf: (id: string) => string | undefined;
  maxRef: () => number;
}

const NO_REPORT: ReportRefs = { refOf: () => undefined, maxRef: () => 0 };

export function refNumber(ref: string | undefined): number {
  const match = /^WR-(\d+)$/.exec(ref ?? '');
  return match ? Number(match[1]) : 0;
}

function clip(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  const masked = maskSecretsInText(text);
  return masked.length > max ? `${masked.slice(0, max)}…` : masked;
}

/**
 * Находка модели — маской, как и сам сбой: модель читает код без ограды пути, а
 * в пачку попадает чужой текст (ошибки страницы, пути запросов) — её ответ мог
 * процитировать прочитанный секрет, и кольцо хранило бы его на диске как есть.
 */
function maskedFinding(finding: WatchFinding): WatchFinding {
  return Object.fromEntries(
    Object.entries(finding).map(([key, value]) => [
      key,
      typeof value === 'string' ? maskSecretsInText(value) : value,
    ]),
  ) as WatchFinding;
}

const earliest = (a: string, b: string): string => (a < b ? a : b);
/** Копия записи наружу: поля кольцо меняет заменой, поэтому верхнего уровня хватает. */
const snapshot = (event: WatchEvent): WatchEvent => ({ ...event });
const latest = (a: string, b: string): string => (a > b ? a : b);

export class WatchEventStore {
  private readonly file: () => string;
  private readonly max: number;
  private readonly refs: ReportRefs;

  /** Каталог — функцией: он меняется на лету (`ctx.relocate`). */
  constructor(appDataDir: () => string, max = WATCH_EVENTS_MAX, refs: ReportRefs = NO_REPORT) {
    this.file = () => join(appDataDir(), WATCH_EVENTS_FILE);
    this.max = max;
    this.refs = refs;
  }

  /**
   * Кольцо в памяти: читается с диска один раз на каталог данных. Писатель у
   * файла один — этот процесс, поэтому память и есть правда, а диск её догоняет.
   */
  private cache: { file: string; data: EventsFile } | undefined;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  private read(): EventsFile {
    const file = this.file();
    if (this.cache?.file === file) return this.cache.data;
    // Каталог данных сменился (`ctx.relocate`): несохранённое — в прежний файл.
    this.flush();
    this.dirty = false;
    const data = this.load(file);
    this.cache = { file, data };
    return data;
  }

  private load(file: string): EventsFile {
    const data = readJsonFile<EventsFile>(file, { events: [] });
    // Запись прошлой версии (без номера, класса и важности) читается как сбой;
    // номер она получает при первом повторе.
    const events = (Array.isArray(data.events) ? data.events : []).map((event) => ({
      ...event,
      ref: event.ref ?? '',
      entryClass: event.entryClass ?? 'failure',
      severity: event.severity ?? DEFAULT_SEVERITY[event.kind] ?? 'medium',
    }));
    return {
      events,
      aliases: data.aliases && typeof data.aliases === 'object' ? data.aliases : {},
      lastRef: typeof data.lastRef === 'number' ? data.lastRef : 0,
    };
  }

  /**
   * Снимки записей, а не сами записи кольца: пачка, ушедшая на разбор, не
   * должна меняться под моделью от повторов, пришедших за время разбора.
   */
  list(): WatchEvent[] {
    return this.read().events.map(snapshot);
  }

  /** Сбои, чьи повторы модель ещё не видела. Замечания разбора не ждут. */
  pending(): WatchEvent[] {
    return this.list().filter(
      (event) => event.entryClass !== 'remark' && event.count > event.analyzedCount,
    );
  }

  /** Раздел по номеру `WR-n` или по отпечатку. */
  find(key: string): WatchEvent | undefined {
    const data = this.read();
    const id = data.aliases?.[key] ?? key;
    const found = data.events.find((event) => event.id === id || event.ref === key);
    return found && snapshot(found);
  }

  private nextRef(data: EventsFile, id: string): string {
    const known = this.refs.refOf(id);
    if (known) return known;
    const inStore = Math.max(0, ...data.events.map((event) => refNumber(event.ref)));
    const next = Math.max(data.lastRef ?? 0, inStore, this.refs.maxRef()) + 1;
    data.lastRef = next;
    return `${REF_PREFIX}${next}`;
  }

  record(signal: WatchSignal, now = new Date().toISOString()): RecordResult {
    const masked: WatchSignal = {
      ...signal,
      message: clip(signal.message, MESSAGE_MAX) ?? '',
      stack: clip(signal.stack, STACK_MAX),
      output: clip(signal.output, STACK_MAX),
      path: clip(signal.path, 500),
      route: clip(signal.route, 300),
    };
    const data = this.read();
    const fingerprint = fingerprintOf(masked);
    const id = data.aliases?.[fingerprint] ?? fingerprint;
    const at = signal.at ?? now;
    const found = data.events.find((event) => event.id === id);
    let event: WatchEvent;
    if (found) {
      if (!found.ref) found.ref = this.nextRef(data, found.id);
      found.count += 1;
      found.lastSeen = latest(found.lastSeen, at);
      // Последний текст — свежее: в нём могут быть другие значения тех же полей.
      found.message = masked.message;
      if (masked.stack) found.stack = masked.stack;
      if (masked.output) found.output = masked.output;
      if (masked.status !== undefined) found.status = masked.status;
      if (masked.route && !found.route) found.route = masked.route;
      if (masked.durationMs !== undefined) {
        found.durationMs = Math.max(found.durationMs ?? 0, masked.durationMs);
      }
      event = found;
    } else {
      event = {
        id,
        ref: this.nextRef(data, id),
        entryClass: 'failure',
        severity: DEFAULT_SEVERITY[masked.kind] ?? 'medium',
        source: masked.source,
        kind: masked.kind,
        message: masked.message,
        ...(masked.stack ? { stack: masked.stack } : {}),
        ...(masked.output ? { output: masked.output } : {}),
        ...(masked.route ? { route: masked.route } : {}),
        ...(masked.method ? { method: masked.method } : {}),
        ...(masked.path ? { path: masked.path } : {}),
        ...(masked.status !== undefined ? { status: masked.status } : {}),
        ...(masked.durationMs !== undefined ? { durationMs: masked.durationMs } : {}),
        firstSeen: at,
        lastSeen: at,
        count: 1,
        analyzedCount: 0,
      };
      data.events.push(event);
    }
    data.events = this.bounded(data.events);
    this.save(data);
    return { event: snapshot(event), isNew: !found, kept: data.events.includes(event) };
  }

  /**
   * Замечание модели. Уже есть (тот же файл и заголовок или модель сослалась
   * на номер) — растёт счётчик, новое — свой раздел со своим номером.
   */
  recordRemark(remark: WatchRemark, now = new Date().toISOString()): RecordResult {
    const data = this.read();
    const title = clip(remark.title, 200) ?? '';
    const location = clip(remark.location, 300);
    const bySame = remark.sameAs
      ? data.events.find(
          (event) =>
            event.entryClass === 'remark' &&
            (event.ref === remark.sameAs || event.id === remark.sameAs),
        )
      : undefined;
    const id = bySame?.id ?? remarkFingerprint(title, location);
    const found = bySame ?? data.events.find((event) => event.id === id);
    const cleaned: WatchRemark = {
      title,
      explanation: clip(remark.explanation, MESSAGE_MAX) ?? '',
      severity: remark.severity,
      ...(location ? { location } : {}),
      ...(remark.fix ? { fix: clip(remark.fix, MESSAGE_MAX) } : {}),
      ...(remark.relatedTo ? { relatedTo: remark.relatedTo } : {}),
    };
    let event: WatchEvent;
    if (found) {
      found.count += 1;
      found.analyzedCount = found.count;
      found.lastSeen = latest(found.lastSeen, now);
      // Первое описание остаётся: повтор другими словами не должен дёргать раздел.
      found.remark = {
        ...cleaned,
        ...found.remark,
        severity: found.remark?.severity ?? cleaned.severity,
      };
      event = found;
    } else {
      event = {
        id,
        ref: this.nextRef(data, id),
        entryClass: 'remark',
        severity: cleaned.severity,
        source: 'model',
        kind: 'remark',
        message: title,
        firstSeen: now,
        lastSeen: now,
        count: 1,
        analyzedCount: 1,
        remark: cleaned,
      };
      data.events.push(event);
    }
    data.events = this.bounded(data.events);
    this.save(data);
    return { event: snapshot(event), isNew: !found, kept: data.events.includes(event) };
  }

  /** Модель разобрала эти сбои: запомнить вердикт и сколько повторов она видела. */
  markAnalyzed(
    seen: ReadonlyMap<string, number>,
    findings: ReadonlyMap<string, WatchFinding>,
  ): void {
    const data = this.read();
    for (const event of data.events) {
      const count = seen.get(event.id);
      if (count === undefined) continue;
      event.analyzedCount = Math.max(event.analyzedCount, count);
      const finding = findings.get(event.id);
      if (finding) {
        event.finding = maskedFinding(finding);
        if (finding.severity) event.severity = finding.severity;
      }
    }
    this.save(data);
  }

  /**
   * Модель доказала, что два сбоя — одна причина: второй вливается в первый.
   * Счётчики складываются, границы по времени — крайние, у влитого остаётся
   * псевдоним. `undefined` — сливать нечего (нет одного из двух или это одно).
   */
  merge(fromKey: string, intoKey: string): { into: WatchEvent; removed: WatchEvent } | undefined {
    const data = this.read();
    const resolve = (key: string) => {
      const id = data.aliases?.[key] ?? key;
      return data.events.find((event) => event.id === id || event.ref === key);
    };
    const from = resolve(fromKey);
    const into = resolve(intoKey);
    if (!from || !into || from.id === into.id) return undefined;
    if (from.entryClass !== into.entryClass) return undefined;
    into.count += from.count;
    into.analyzedCount += from.analyzedCount;
    into.firstSeen = earliest(into.firstSeen, from.firstSeen);
    into.lastSeen = latest(into.lastSeen, from.lastSeen);
    // Запись прошлой версии без номера не даёт пустой ссылки в «влиты сюда».
    into.merged = [
      ...new Set([...(into.merged ?? []), from.ref, ...(from.merged ?? [])].filter(Boolean)),
    ];
    const aliases = data.aliases ?? {};
    aliases[from.id] = into.id;
    for (const [key, target] of Object.entries(aliases))
      if (target === from.id) aliases[key] = into.id;
    data.aliases = aliases;
    data.events = data.events.filter((event) => event.id !== from.id);
    this.save(data);
    return { into: snapshot(into), removed: from };
  }

  /**
   * Убрать запись совсем: баг, присланный человеком, модель не подтвердила —
   * в кольце ему не место, иначе следующий разбор взял бы его снова.
   */
  drop(key: string): void {
    const data = this.read();
    const id = data.aliases?.[key] ?? key;
    const kept = data.events.filter((event) => event.id !== id);
    if (kept.length === data.events.length) return;
    data.events = kept;
    this.save(data);
  }

  /** Новое включение: кольцо пустое, номера продолжаются. */
  clear(): void {
    const data = this.read();
    this.save({ events: [], aliases: {}, lastRef: data.lastRef ?? 0 });
  }

  /** Сверх потолка — вон самые давние по последнему появлению. */
  private bounded(events: WatchEvent[]): WatchEvent[] {
    if (events.length <= this.max) return events;
    return [...events]
      .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0))
      .slice(0, this.max);
  }

  /** Правка кольца: память сразу, диск — одной записью по окну. */
  private save(data: EventsFile): void {
    this.cache = { file: this.file(), data };
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), WATCH_EVENTS_FLUSH_MS);
    // Таймер не держит процесс: на выходе запись делает `flush` из `shutdown`.
    this.flushTimer.unref?.();
  }

  /**
   * Записать несохранённое сейчас — окно истекло, панель выходит или сменился
   * каталог данных. Не записалось — правка остаётся несохранённой и уйдёт со
   * следующей: сбой диска в таймере не должен ронять сервер.
   */
  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.dirty || !this.cache) return;
    try {
      writeJsonFile(this.cache.file, this.cache.data satisfies EventsFile, { preserveForm: false });
      this.dirty = false;
    } catch {
      // Кольцо в памяти цело; следующая правка или выход попробуют снова.
    }
  }
}
