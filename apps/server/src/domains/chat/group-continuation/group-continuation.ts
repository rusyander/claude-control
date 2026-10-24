import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HandoffProposal } from '@agentdeck/contracts/chat-handoff';
import type { RunOptions } from '../ChatRunner/ChatRunner.ts';

/**
 * Продолжение ребёнка разделения посреди стадии — той же сессией, а не чистой
 * (E1 плана экономии, замер 20.10.2026).
 *
 * Блок продолжения в ответе группы заводил новую сессию без `--resume`. Замер
 * по деревьям разделения 29.09–20.10: 24 таких сессии, 13 % всей траты деревьев,
 * и каждая тратила ~13 вызовов до первой правки, перечитывая то, что прежняя
 * сессия держала в окне. Окно у них при этом было далеко от сжатия: группе
 * задача нарезана под один-два хода, и «чистый лист» ей нужен разве что тогда,
 * когда окно и правда подходит к автосжатию.
 *
 * Поэтому решает размер окна: ниже доли окна сжатия — продолжение той же
 * сессией (CLI сам сожмёт контекст, если дорастёт), выше — чистая сессия, как
 * раньше. Предохранители (`evaluateHandoff`: свежий файл-опора, потолок цепочки,
 * «ходит по кругу») действуют на обе ветки одинаково — шаг той же сессией
 * считается шагом цепочки.
 *
 * Здесь только арифметика и текст: решает модуль, делает планировщик.
 */

/**
 * Доля окна сжатия, с которой группе положена чистая сессия. Ниже — перечитывание
 * всего заново дороже, чем перевыставлять из кэша то, что уже в окне (кэш на
 * чтение стоит десятую часть входа). Выше — до автосжатия CLI остаётся меньше
 * половины окна, и сводка сводок начинает стоить качества.
 */
export const GROUP_FRESH_SESSION_SHARE = 0.6;

/**
 * Окно сжатия, когда ни прогон, ни настройки его не называют: стандартное окно
 * облачной модели. Меньше 8k окно не бывает — это мусор в настройке.
 */
export const DEFAULT_COMPACT_WINDOW = 200_000;
const MIN_COMPACT_WINDOW = 8_000;

/** Переменная CLI, перекрывающая `autoCompactWindow` из settings.json. */
const COMPACT_WINDOW_ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';

function windowValue(raw: unknown): number | undefined {
  const value = Number(raw);
  return Number.isFinite(value) && value >= MIN_COMPACT_WINDOW ? value : undefined;
}

/**
 * Окно, при котором CLI ЭТОГО прогона сожмёт контекст: переменная прогона
 * (профиль группы, локальная модель) сильнее настройки каталога конфигурации.
 */
export function effectiveCompactWindow(
  env: Record<string, string> | undefined,
  settingsWindow: number | undefined,
): number {
  return (
    windowValue(env?.[COMPACT_WINDOW_ENV]) ?? windowValue(settingsWindow) ?? DEFAULT_COMPACT_WINDOW
  );
}

/**
 * Окно закончившегося прогона: рычаг окна групп, затем окружение прогона, затем
 * `platformEnv` — последним, как при запуске процесса (`ChatRunner`): окно
 * локальной модели и профиля группы едет именно там, и без него 65 тыс.
 * локальной модели читались бы как окно каталога конфигурации.
 */
export function runCompactWindow(
  options: Pick<RunOptions, 'env' | 'platformEnv'>,
  groupWindow: number | undefined,
  settingsWindow: number | undefined,
): number {
  return effectiveCompactWindow(
    {
      ...(groupWindow ? { [COMPACT_WINDOW_ENV]: String(groupWindow) } : {}),
      ...options.env,
      ...options.platformEnv,
    },
    settingsWindow,
  );
}

/**
 * `autoCompactWindow` из settings.json каталога конфигурации; нет файла, поля или
 * файл битый — `undefined`, решает окно по умолчанию.
 */
export function settingsCompactWindow(configDir: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as {
      autoCompactWindow?: unknown;
    };
    return windowValue(parsed.autoCompactWindow);
  } catch {
    return undefined;
  }
}

export interface GroupContinuationInput {
  /** Окно на последнем шаге прогона; 0 — расход не приходил. */
  contextTokens: number;
  /** Окно сжатия прогона (`effectiveCompactWindow`). */
  compactWindow: number;
  /** Сессия закрывшегося хода: без неё продолжать «ту же» нечего. */
  sessionId?: string;
}

/**
 * Чем продолжать группу, чьё предложение прошло предохранители.
 *
 * Нулевой расход (усыновлённый прогон, расход не пришёл) — та же сессия: размер
 * неизвестен, а CLI при переполнении сожмёт её сам; чистая сессия наугад стоила
 * бы перечитывания всего наверняка.
 */
export function groupContinuation({
  contextTokens,
  compactWindow,
  sessionId,
}: GroupContinuationInput): 'resume' | 'fresh' {
  if (!sessionId) return 'fresh';
  return contextTokens >= compactWindow * GROUP_FRESH_SESSION_SHARE ? 'fresh' : 'resume';
}

/**
 * Задание хода той же сессией. Английское — его читает только модель. Говорит
 * прямо, что сессия сохранена намеренно: без этого агент на следующем ходу снова
 * просит «чистый лист» и перечитывает то, что уже держит.
 */
export function continueHerePrompt(proposal: HandoffProposal): string {
  return [
    'Continue in this same session — the panel kept it on purpose: a fresh session would ' +
      're-read everything you already hold, and the CLI compacts the context itself when it fills up.',
    `Next: ${proposal.next}`,
    'Do not re-read files whose content is already in this conversation. When the work of the ' +
      'group is done, end the turn with the result instead of another continuation block.',
  ].join('\n');
}

/**
 * Последняя сессия работы или правок группы — та, что держит в окне ветку,
 * задачи и итоги проверок (E2 плана экономии, замер 29.09–20.10: доставка в
 * чистой сессии — 23 % траты деревьев, почти вся на то, чтобы узнать это заново).
 */
export interface WarmGroupSession {
  sessionId: string;
  /** Параметры хода ровно в том виде, в каком он шёл: дописка — байт в байт. */
  options: RunOptions;
  /**
   * Модель и глубина, которые ход ПРОСИЛ. Через контур в `options` лежат
   * модель маршрута и пустая глубина, и сравнение с назначением доставки не
   * сходилось бы никогда (ревью E1–E7, L1).
   */
  model: string;
  effort: string;
  /** Конец хода — с него отсчитывается жизнь кэша. */
  at: number;
  contextTokens: number;
}

/**
 * Сколько тёплой сессии живёт кэш: TTL кэша CLI — час с последнего попадания,
 * пять минут — запас на абзац сит и очередь старта. Старше — продолжение
 * писало бы весь контекст в кэш заново и стоило бы дороже чистой доставки.
 */
export const WARM_SESSION_MAX_AGE_MS = 55 * 60_000;

/**
 * С какой паузы кэш считается остывшим. Срок кэша CLI на подписке — час с
 * последнего попадания, но продолжение на 58–60-й минуте может прийти уже в
 * холодный кэш, поэтому запас тот же, что у тёплой доставки.
 */
export const COLD_CACHE_MS = WARM_SESSION_MAX_AGE_MS;

/** То же для пятиминутного кэша (`groupEconomy.cacheTtl = '5m'`). */
export const COLD_CACHE_SHORT_MS = 4 * 60_000;

/**
 * Окно первого вызова свежей сессии группы, когда транскрипт его не называет:
 * медиана замера 20.10 — 62k, округлено вниз, чтобы не продолжать лишнего.
 */
export const FRESH_BASE_TOKENS = 60_000;

/**
 * Насколько окно должно превысить базу свежей сессии, чтобы переписать его было
 * дороже, чем начать заново: свежий разговор платит запись базы и десяток
 * вызовов на то, чтобы прочесть вводную и заметки.
 */
export const COLD_RESUME_MARGIN_TOKENS = 25_000;

export interface ColdResumeInput {
  /** Сколько сессия стоит с последней записи в транскрипт. */
  idleMs: number;
  /** Окно последнего вызова модели в этой сессии; 0 — неизвестно. */
  contextTokens: number;
  /** Окно ПЕРВОГО вызова этой сессии — её база; 0 или нет — `FRESH_BASE_TOKENS`. */
  freshBase?: number;
  /** Срок кэша групп из настроек: '' и '1h' — час, '5m' — пять минут. */
  cacheTtl?: string;
  /**
   * Свой срок остывания, мс, — сильнее `cacheTtl`: у чужого CLI кэш провайдера
   * живёт по своим правилам (`foreign-cold.ts`), а не по настройке Claude.
   */
  coldAfterMs?: number;
}

/**
 * Продолжить группу новым разговором, а не остывшей сессией (рычаг
 * `groupEconomy.freshOnColdResume`, замечания 8 и 12 прогона 20.10).
 *
 * Продолжение остывшей сессии пишет в кэш всё окно заново — по цене записи, а
 * не чтения, — и тянет его дальше до сжатия. Новый разговор начинает с базы и
 * вводной, собранной панелью из файлов. Порог по окну абсолютный (база + 25k,
 * ≈85k сегодня), а не доля окна сжатия: при окне 250k доля 0,6 — это 150k, и
 * холодное продолжение 85–150k платило бы переписывание целиком. Окно
 * неизвестно (0) — продолжаем, как раньше.
 */
export function coldResume({
  idleMs,
  contextTokens,
  freshBase,
  cacheTtl,
  coldAfterMs,
}: ColdResumeInput): boolean {
  if (contextTokens <= 0) return false;
  const ttl = cacheTtl === '5m' ? COLD_CACHE_SHORT_MS : COLD_CACHE_MS;
  const coldAfter = coldAfterMs ?? ttl;
  const base = freshBase && freshBase > 0 ? freshBase : FRESH_BASE_TOKENS;
  return idleMs >= coldAfter && contextTokens >= base + COLD_RESUME_MARGIN_TOKENS;
}

/** Окно, выше которого доставка идёт с чистого листа даже при тёплом кэше. */
export const WARM_DELIVER_MAX_CONTEXT = 200_000;

export interface WarmDeliverInput {
  warm: WarmGroupSession | undefined;
  now: number;
  /** Назначение доставки: кэш живёт под моделью и глубиной, другие — другой кэш. */
  model: string | undefined;
  effort: string | undefined;
  compactWindow: number;
}

/**
 * Продолжать ли доставку тёплой сессией группы. Да — только когда кэш почти
 * наверняка жив: та же модель и глубина, моложе часа, окно известно и далеко
 * от сжатия (та же доля, что у продолжений E1). Расход не пришёл (0) — нет:
 * промах кэша на большом окне дороже чистой доставки.
 */
export function warmDeliverSession({
  warm,
  now,
  model,
  effort,
  compactWindow,
}: WarmDeliverInput): WarmGroupSession | undefined {
  if (!warm?.sessionId) return undefined;
  if (now - warm.at >= WARM_SESSION_MAX_AGE_MS) return undefined;
  const ceiling = Math.min(WARM_DELIVER_MAX_CONTEXT, compactWindow * GROUP_FRESH_SESSION_SHARE);
  if (warm.contextTokens <= 0 || warm.contextTokens >= ceiling) return undefined;
  if (warm.model !== (model ?? '')) return undefined;
  if (warm.effort !== (effort ?? '')) return undefined;
  return warm;
}

/**
 * Строка задания доставки в тёплой сессии. Английская — её читает только
 * модель. Без неё агент начинает доставку с того же обхода ветки, что и в
 * чистой сессии, и выигрыш съедается.
 *
 * Вторая фраза — потому что дописка к системному промпту наследуется байт в
 * байт (иначе кэш не тёплый): у работы ниже потолка там стоят «модель ниже
 * потолка», «перезапустись на потолке» и «после тебя панель заведёт ревью».
 * Для доставки это прошедшая стадия, и без оговорки агент ждал бы ревью,
 * которого за доставкой нет, или просился бы на потолок посреди доставки.
 */
export const WARM_DELIVER_LINE =
  "Delivery stage, continued from the session that did this group's work: the changes, the plan " +
  'and the check results are already in this conversation — do not re-read or re-explore them; ' +
  'follow the delivery steps below. Any system-prompt lines about running below the ceiling, ' +
  'asking to re-run on the ceiling or a review still to come describe the work stage, which is ' +
  'over: no review follows this turn, it only delivers.';
