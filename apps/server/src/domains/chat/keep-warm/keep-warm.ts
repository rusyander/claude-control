import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SplitGroupKeepWarm } from '@agentdeck/contracts/chat-handoff';
import { modelFactor, windowWeight } from '../../analytics/token-audit/window-weight.ts';
import type { LimitRunRecord } from '../limit-journal/limit-journal.ts';
import { readTailRecords } from '../ChatTranscriptFile/ChatTranscriptFile.ts';
import { toUsage } from '../ChatRecords/ChatRecords.ts';
import type { RunOptions } from '../ChatRunner/ChatRunner.ts';
import type {
  KeepWarmDecision,
  KeepWarmFile,
  KeepWarmInput,
  KeepWarmSessionState,
  KeepWarmTemplate,
  SessionCallTail,
} from './keep-warm.types.ts';

/**
 * Пинг тёплого кэша группы (замер X2 22.10, владелец: «ты же его будешь
 * встраивать»). Группа, ждущая человека, паузы или очереди тяжёлых шагов,
 * через час простоя теряет кэш, и следующий её ход переписывает
 * всё окно по цене записи. Пинг на 50-й минуте — ответвление сессии с одним
 * словом — читает окно из кэша и продлевает ему час: в X2 это 1/16 перезаписи.
 *
 * Здесь — решение и учёт, без процессов: что пинговать и когда. Запускает пинг
 * проводка (`bootstrap/keep-warm-wiring`) через реестр прогонов.
 */

/** Пинг — за десять минут до конца часового кэша: тик раз в минуту успевает. */
export const KEEP_WARM_AFTER_MS = 50 * 60_000;
/** Часовой кэш: позже пинг уже не читает окно, а пишет его заново — это дело холодного пути. */
export const KEEP_WARM_TTL_MS = 60 * 60_000;
/** Сорвавшийся пинг (сеть, отказ CLI) повторяется не раньше чем через пять минут. */
export const KEEP_WARM_RETRY_MS = 5 * 60_000;
/** Записи ожиданий старше суток вычищаются: такой кэш давно остыл, а сессия ушла. */
const STATE_MAX_AGE_MS = 24 * 60 * 60_000;
/** Счёт пингов группы вычищается через месяц после её последнего пинга. */
const LEDGER_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** Хвоста в полмегабайта хватает на последний вызов даже за большим выводом. */
const TAIL_BYTES = 512 * 1024;

/**
 * Слово пинга. Ответвление несёт всю сессию группы с её правами, поэтому
 * просьба не трогать инструменты — словами; оборвать вызов, если он всё же
 * случится, — дело `runWarmPing`.
 */
export const KEEP_WARM_PROMPT =
  'Panel keep-alive check, not a task: reply with exactly one word, "ok", and use no tools.';

/** Файл учёта пингов в каталоге данных панели. */
export function keepWarmPath(appDataDir: string): string {
  return join(appDataDir, 'keep-warm.json');
}

/**
 * Пинговать ли сессию сейчас. Порядок проверок — от дешёвых и общих к счёту
 * этого ожидания; причина отказа уходит в журнал проводки как есть.
 */
export function decideKeepWarm(input: KeepWarmInput): KeepWarmDecision {
  const { economy, tail, state } = input;
  if (!economy?.keepWarm) return { kind: 'skip', reason: 'off' };
  if (economy.cacheTtl === '5m') return { kind: 'skip', reason: 'ttl-5m' };
  if (!input.wait) return { kind: 'skip', reason: 'not-waiting' };
  // Идущий ход сам держит кэш. Исключения — ход, который стоит не по воле
  // модели: запрос прав человеку и ожидание места в очереди тяжёлых шагов.
  if (input.running && input.wait !== 'ask' && input.wait !== 'heavy-queue') {
    return { kind: 'skip', reason: 'running' };
  }
  if (!tail) return { kind: 'skip', reason: 'no-transcript' };
  if (tail.ttl === '5m') return { kind: 'skip', reason: 'ttl-5m' };
  // Часовой кэш не подтверждён: модель маршрута кэш не пишет (локальная модель,
  // модель контура не из семейства Claude — vLLM, gpt) — пинг был бы полным запросом
  // без кэша, греть нечего. Claude через контур кэш пишет и сюда не попадает;
  // исчерпанный бюджет контура пинг не пускает в реестре прогонов (`warm`).
  if (tail.ttl !== '1h') return { kind: 'skip', reason: 'ttl-unknown' };
  if (tail.contextTokens < input.coldContextTokens) return { kind: 'skip', reason: 'small' };
  if (input.rateLimited) return { kind: 'skip', reason: 'rate-limited' };
  // Новое ожидание — новый вызов модели после прошлого: счёт с нуля.
  const same = state?.waitKey === tail.lastCallAt ? state : undefined;
  if (same?.ttl5m) return { kind: 'skip', reason: 'ttl-5m' };
  if (same?.missed) return { kind: 'skip', reason: 'miss' };
  const pings = same?.pings ?? 0;
  if (pings >= economy.keepWarmPings) return { kind: 'skip', reason: 'cap' };
  const warmFrom = Math.max(tail.lastCallAt, same?.warmedAt ?? 0);
  const idle = input.now - warmFrom;
  if (idle >= KEEP_WARM_TTL_MS) return { kind: 'skip', reason: 'cold' };
  if (idle < KEEP_WARM_AFTER_MS) return { kind: 'skip', reason: 'not-yet' };
  if (same?.lastPingAt !== undefined && input.now - same.lastPingAt < KEEP_WARM_RETRY_MS) {
    return { kind: 'skip', reason: 'not-yet' };
  }
  return { kind: 'ping', waitKey: tail.lastCallAt, pings };
}

/** Последний вызов модели сессии и срок её кэша — по хвосту транскрипта. */
export function sessionCallTail(file: string): SessionCallTail | undefined {
  const tail = readTailRecords(file, TAIL_BYTES);
  let last: SessionCallTail | undefined;
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const record = tail[index]!;
    // Ветка субагента — не вызов сессии: кэш её окна держат вызовы самой сессии.
    if (record.isSidechain) continue;
    const usage = toUsage(record);
    const at = record.timestamp ? Date.parse(record.timestamp) : NaN;
    if (!usage || !Number.isFinite(at)) continue;
    if (!last) {
      last = {
        lastCallAt: at,
        contextTokens: usage.input + usage.cacheRead + usage.cacheCreation,
        ttl: 'unknown',
      };
    }
    if (usage.cacheCreation > 0) {
      last.ttl = (usage.cacheCreation1h ?? 0) > 0 ? '1h' : '5m';
      break;
    }
  }
  return last;
}

/**
 * Исчерпан ли лимит подписки по журналу лимита: последний замер окна (пять
 * часов или неделя) показывает загрузку до упора, а сброс ещё впереди.
 * `resetsAt` в журнале — секунды эпохи, как в событии CLI.
 */
export function rateLimitedNow(runs: readonly LimitRunRecord[], now: number): boolean {
  const latest: Partial<Record<'fiveHour' | 'sevenDay', { at: number; full: boolean }>> = {};
  for (const run of runs) {
    for (const sample of run.samples) {
      for (const window of ['fiveHour', 'sevenDay'] as const) {
        const value = sample[window];
        if (!value || !Number.isFinite(sample.at)) continue;
        const known = latest[window];
        if (known && known.at >= sample.at) continue;
        latest[window] = {
          at: sample.at,
          full: value.utilization >= 0.999 && value.resetsAt * 1000 > now,
        };
      }
    }
  }
  return Boolean(latest.fiveHour?.full || latest.sevenDay?.full);
}

/** Попадание пинга: прочитал не меньше этой доли окна сессии... */
export const KEEP_WARM_HIT_READ = 0.9;
/** ...и записал не больше этой: больше — префикс пинга разошёлся с ходом группы. */
export const KEEP_WARM_HIT_WRITE = 0.1;

/**
 * Попал ли пинг в кэш группы. Только по расходу самого пинга против окна её
 * последнего вызова: пинг, который до модели дошёл, но окно переписал (другой
 * префикс — свежий процесс собрал иной системный промпт), кэша хода не греет, а
 * перезапись по часовой цене уже заплачена.
 */
export function pingVerdict(usage: WarmUsageLike, contextTokens: number): 'hit' | 'miss' {
  if (contextTokens <= 0) return 'miss';
  const read = usage.cacheRead >= KEEP_WARM_HIT_READ * contextTokens;
  const small = usage.cacheWrite <= KEEP_WARM_HIT_WRITE * contextTokens;
  return read && small ? 'hit' : 'miss';
}

/** Расход пинга в полях веса окна (`WeightTokens`). */
export interface WarmUsageLike {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
}

/** Вес вызова в токенах по цене входа модели (W без множителя модели), целым. */
function inputPriceTokens(usage: WarmUsageLike, model: string | undefined): number {
  return Math.round((windowWeight(usage, model) * 1e6) / modelFactor(model));
}

/** Расход одного пинга в токенах по цене входа — попадание или промах, всё равно. */
export function pingCost(usage: WarmUsageLike, model: string | undefined): number {
  return inputPriceTokens(usage, model);
}

/**
 * Что сберегает продолжение, прочитавшее окно из кэша, который без пингов
 * остыл бы: перезапись окна по часовой цене минус его чтение, в токенах по цене
 * входа. Пинги из этого вычитает счёт ожидания (`settleGroup`).
 */
export function rewriteAvoided(contextTokens: number, model: string | undefined): number {
  const rewrite = inputPriceTokens(
    { input: 0, cacheRead: 0, cacheWrite: contextTokens, cacheWrite1h: contextTokens, output: 0 },
    model,
  );
  const reread = inputPriceTokens(
    { input: 0, cacheRead: contextTokens, cacheWrite: 0, cacheWrite1h: 0, output: 0 },
    model,
  );
  return rewrite - reread;
}

/** Первый вызов модели сессии после ожидания — продолжение, по транскрипту. */
export interface ResumeCall {
  /** Когда ушёл запрос, то есть когда модель читала кэш (см. `firstCallAfter`). */
  at: number;
  cacheRead: number;
}

/** Вызов сессии: конец ответа (время записи) и запрос перед ним, если он записан. */
interface SessionCall {
  at: number;
  requestAt?: number;
  cacheRead: number;
}

/**
 * Первый вызов сессии позже `after` (конца последнего вызова перед ожиданием).
 * Время — его запроса: запись сессии перед вызовом (`user` — ответ человека),
 * если она позже `after`; иначе — запись самого вызова. Кэш модель читает,
 * когда запрос ушёл, а ответ дописывается в транскрипт в конце — продолжение,
 * начатое в тёплом часе, иначе выглядело бы пришедшим к остывшему кэшу.
 * Хвоста хватает почти всегда — проводка смотрит раз в минуту; если и самый
 * ранний вызов хвоста уже позже `after`, продолжение могло уйти выше — тогда весь файл.
 */
export function firstCallAfter(file: string, after: number): ResumeCall | undefined {
  let calls = sessionCalls(readTailRecords(file, TAIL_BYTES));
  if ((calls[0]?.at ?? -Infinity) > after && statSync(file).size > TAIL_BYTES) {
    calls = sessionCalls(readTailRecords(file, Number.POSITIVE_INFINITY));
  }
  const call = calls.find((item) => item.at > after);
  if (!call) return undefined;
  const at = call.requestAt !== undefined && call.requestAt > after ? call.requestAt : call.at;
  return { at, cacheRead: call.cacheRead };
}

/** Вызовы модели самой сессии (без веток субагентов) по порядку записи. */
function sessionCalls(records: ReturnType<typeof readTailRecords>): SessionCall[] {
  const calls: SessionCall[] = [];
  let requestAt: number | undefined;
  for (const record of records) {
    if (record.isSidechain) continue;
    const at = record.timestamp ? Date.parse(record.timestamp) : NaN;
    if (!Number.isFinite(at)) continue;
    if (record.type === 'user') {
      requestAt = at;
      continue;
    }
    const usage = toUsage(record);
    if (!usage) continue;
    calls.push({
      at,
      ...(requestAt !== undefined ? { requestAt } : {}),
      cacheRead: usage.cacheRead,
    });
    requestAt = undefined;
  }
  return calls;
}

/**
 * Итог ожидания с пингами — экономия только состоявшаяся. Продолжение уже было:
 * сбережено, если оно прочитало окно из кэша (≥ 90 %), пришло не раньше, чем
 * кэш остыл бы без пингов (час от последнего настоящего вызова), и не позже
 * часа от согревшего пинга. Ответ на 55-й минуте прочёл бы тёплый кэш и без
 * пинга — пинги тогда чистый расход. Продолжения нет, а кэш уже остыл и после
 * пингов (потолок вышел, группу закрыли, разговор начат заново) — тоже расход.
 * Иначе итог ещё не известен.
 */
export function settleWait(
  state: KeepWarmSessionState,
  resume: ResumeCall | undefined,
  now: number,
): { avoided: number } | undefined {
  if (state.spent === undefined) return undefined;
  const window = state.contextTokens ?? 0;
  if (resume) {
    const realized =
      state.warmedAt !== undefined &&
      resume.at - state.waitKey >= KEEP_WARM_TTL_MS &&
      resume.at - state.warmedAt < KEEP_WARM_TTL_MS &&
      window > 0 &&
      resume.cacheRead >= KEEP_WARM_HIT_READ * window;
    return { avoided: realized ? rewriteAvoided(window, state.model) : 0 };
  }
  if (now - Math.max(state.waitKey, state.warmedAt ?? 0) >= KEEP_WARM_TTL_MS) return { avoided: 0 };
  return undefined;
}

/**
 * Пинг, дошедший до модели, — в счёт группы: число, попадания, токены и его
 * расход в «ожидающие итога» (`pending`); экономию решает `settleGroup`.
 */
export function addPing(
  prev: SplitGroupKeepWarm | undefined,
  usage: WarmUsageLike,
  verdict: 'hit' | 'miss',
  cost: number,
  at: string,
): SplitGroupKeepWarm {
  return {
    ...prev,
    pings: (prev?.pings ?? 0) + 1,
    hits: (prev?.hits ?? 0) + (verdict === 'hit' ? 1 : 0),
    misses: (prev?.misses ?? 0) + (verdict === 'miss' ? 1 : 0),
    input: (prev?.input ?? 0) + usage.input,
    cacheRead: (prev?.cacheRead ?? 0) + usage.cacheRead,
    cacheWrite: (prev?.cacheWrite ?? 0) + usage.cacheWrite,
    output: (prev?.output ?? 0) + usage.output,
    pending: (prev?.pending ?? 0) + cost,
    lastAt: at,
  };
}

/**
 * Итог ожидания — в счёт группы: его пинги уходят из «ожидающих итога», к
 * сбереженному прибавляется избавление от перезаписи (если продолжение его
 * получило) минус расход этих пингов. `saved` без `settled` писал прежний счёт
 * (попадание = сбережение) — карточка его не показывает, и первый итог считает
 * с нуля, а не поверх него.
 */
export function settleGroup(
  prev: SplitGroupKeepWarm,
  spent: number,
  avoided: number,
): SplitGroupKeepWarm {
  const pending = Math.max(0, (prev.pending ?? 0) - spent);
  const { pending: _pending, ...rest } = prev;
  const before = prev.settled !== undefined ? (prev.saved ?? 0) : 0;
  return {
    ...rest,
    ...(pending > 0 ? { pending } : {}),
    settled: (prev.settled ?? 0) + 1,
    realized: (prev.realized ?? 0) + (avoided > 0 ? 1 : 0),
    saved: before + avoided - spent,
  };
}

/** Ключ счёта группы в учёте пингов — как у сигналов сторожа (`родитель#индекс`). */
export function keepWarmGroupKey(parentChatId: string, groupIndex: number): string {
  return `${parentChatId}#${groupIndex}`;
}

/**
 * Счёт пингов группы для вида. Дерево собирается на каждый запрос по всем
 * группам — файл перечитывается, только когда он изменился.
 */
export function createKeepWarmLedgerReader(
  appDataDir: string,
): (parentChatId: string, groupIndex: number) => SplitGroupKeepWarm | undefined {
  const path = keepWarmPath(appDataDir);
  let stamp = '';
  let groups: Record<string, SplitGroupKeepWarm> = {};
  return (parentChatId, groupIndex) => {
    let next = 'absent';
    try {
      const info = statSync(path);
      next = `${info.mtimeMs}:${info.size}`;
    } catch {
      groups = {};
    }
    if (next !== stamp) {
      stamp = next;
      groups = next === 'absent' ? {} : (readKeepWarm(path).groups ?? {});
    }
    return groups[keepWarmGroupKey(parentChatId, groupIndex)];
  };
}

/** Параметры хода группы без секретов и без того, что реестр решает на каждом старте. */
export function keepWarmTemplate(options: RunOptions, origin?: string): KeepWarmTemplate {
  return {
    cwd: options.cwd,
    ...(options.command ? { command: options.command } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
    ...(options.permissionPrompt ? { permissionPrompt: options.permissionPrompt } : {}),
    ...(options.appendSystemPrompt ? { appendSystemPrompt: options.appendSystemPrompt } : {}),
    ...(options.configDir ? { configDir: options.configDir } : {}),
    ...(options.settingSources ? { settingSources: options.settingSources } : {}),
    ...(origin ? { origin } : {}),
  };
}

/** Параметры пинга из сохранённых: слово — своё, остальное реестр дособерёт. */
export function templateOptions(template: KeepWarmTemplate, sessionId: string): RunOptions {
  const { origin: _origin, ...options } = template;
  return { ...options, prompt: KEEP_WARM_PROMPT, sessionId };
}

/** Учёт пингов с диска; нет файла или он битый — пустой (пинги — оптимизация, не данные). */
export function readKeepWarm(path: string): KeepWarmFile {
  if (!existsSync(path)) return { sessions: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<KeepWarmFile>;
    const sessions = parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {};
    const groups = parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : undefined;
    return {
      sessions,
      ...(typeof parsed.limitedUntil === 'number' ? { limitedUntil: parsed.limitedUntil } : {}),
      ...(groups ? { groups } : {}),
    };
  } catch {
    return { sessions: {} };
  }
}

/**
 * Когда сессию последний раз согрел пинг — решению о продолжении (`warmedAt`):
 * транскрипт пинга не пишется, и время файла о нём не знает.
 */
export function warmedAtOf(appDataDir: string, sessionId: string): number | undefined {
  return readKeepWarm(keepWarmPath(appDataDir)).sessions[sessionId]?.warmedAt;
}

/** Запись через временный файл: оборванная запись не оставит половину JSON. */
export function writeKeepWarm(path: string, file: KeepWarmFile, now: number): void {
  const sessions: Record<string, KeepWarmSessionState> = {};
  for (const [id, state] of Object.entries(file.sessions)) {
    if (now - state.touchedAt < STATE_MAX_AGE_MS) sessions[id] = state;
  }
  // Счёт группы живёт, пока его показывает карточка: месяц — с запасом на любое разделение.
  const groups = Object.fromEntries(
    Object.entries(file.groups ?? {}).filter(
      ([, ledger]) => now - Date.parse(ledger.lastAt) < LEDGER_MAX_AGE_MS,
    ),
  );
  const kept: KeepWarmFile = {
    sessions,
    ...(file.limitedUntil !== undefined && file.limitedUntil > now
      ? { limitedUntil: file.limitedUntil }
      : {}),
    ...(Object.keys(groups).length > 0 ? { groups } : {}),
  };
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(kept, null, 2), 'utf8');
  renameSync(temp, path);
}
