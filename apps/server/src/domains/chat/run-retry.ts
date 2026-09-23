import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import type { RunOptions } from './ChatRunner.ts';
import type { RunFinished, RunMeta } from './ChatRunRegistry.ts';
import { isRetriableRunError } from './run-errors.ts';

/**
 * Серверный надзор за упавшими прогонами дерева (Д10).
 *
 * Авто-повтор был только в браузере: работал, пока открыта вкладка, и лишь для
 * прогонов, которые она сама отправила. Детей, звенья и ходы, заведённые
 * сервером, не повторял никто: сеть мигнула — и группа `failed` навсегда.
 *
 * Здесь — одно правило для ребёнка разделения:
 *  - временный сбой (сеть, 5xx, перегрузка, смерть процесса без итога) —
 *    продолжение ТОЙ ЖЕ сессии через паузу, попыток не больше `MAX_ATTEMPTS`;
 *  - упёрлись в лимит — повтор в момент сброса (`rate_limit_event.resetsAt`);
 *  - остальное (отказ запуска, ошибка по существу) — не повторяется.
 * Остановка человеком сюда не приходит вовсе: у остановленного прогона нет
 * `finish`, а значит, и повода.
 */

export const MAX_ATTEMPTS = 3;
/** Паузы перед попытками: сбой сети обычно проходит за минуты, не за секунды. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 300_000] as const;
/** Запас после сброса лимита: часы CLI и панели не атомарны. */
const LIMIT_MARGIN_MS = 60_000;
/** Дальше этого лимит не ждём: сутки простоя — решение человека, а не таймера. */
const LIMIT_HORIZON_MS = 24 * 60 * 60_000;

export type FailureKind = 'transient' | 'limit' | 'fatal';

export function classifyFailure(
  finished: Pick<RunFinished, 'error' | 'limit'>,
  now: number,
): { kind: FailureKind; at?: number } {
  const limit = finished.limit;
  if (limit?.status === 'rejected' && limit.resetsAt > 0) {
    const at = limit.resetsAt * 1000 + LIMIT_MARGIN_MS;
    if (at - now <= LIMIT_HORIZON_MS) return { kind: 'limit', at: Math.max(at, now) };
  }
  const error = finished.error ?? '';
  // Процесс закрылся ненулевым кодом, не назвав причины: убит, упал, потерял
  // сеть посреди хода. Отказ ЗАПУСКА сюда не попадает — у него своя строка.
  if (/завершился с кодом/.test(error)) return { kind: 'transient' };
  return { kind: isRetriableRunError(error) ? 'transient' : 'fatal' };
}

/**
 * Повторяется ли ход этого разговора: ребёнок разделения на звене работы, а не
 * план и не разбор. Упавший план панель и так заменяет работой по заданию,
 * упавший разбор — группами как предложено, и повтор поверх этого завёл бы
 * второго агента на ту же задачу.
 */
export function retriesLink(link: Pick<ChatLink, 'parentChatId' | 'stage'> | undefined): boolean {
  return Boolean(link?.parentChatId) && link?.stage !== 'plan' && link?.stage !== 'triage';
}

/** Что уходит сессии при повторе: не задача заново, а продолжение с места обрыва. */
export function retryPrompt(error: string | undefined): string {
  const why = error ? ` (${error.replace(/\s+/g, ' ').slice(0, 200)})` : '';
  return (
    `Прошлый ход оборвался сбоем${why}. Продолжай с места обрыва: проверь, что уже ` +
    'сделано в копии, и доведи задачу до конца. Заново не начинай.'
  );
}

export interface RunRetryDeps {
  /** Завести прогон; `false` — реестр отказал (разговор уже идёт). */
  start: (chatId: string, options: RunOptions, meta: RunMeta) => boolean;
  schedule?: (run: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  now?: () => number;
  log: (message: string, error?: unknown) => void;
}

/** Решение по упавшему ходу: будет повтор (и когда) или группа сдаётся. */
export type RetryDecision =
  | { retrying: true; attempt: number; at: number }
  | { retrying: false; attempts: number; kind: FailureKind };

/** Решение надзора глазами итога группы (`chainOutcomeOf`): ждёт повтора или сдалась. */
export function retryOutcome(
  decision: RetryDecision | undefined,
): { attempt: number; at: number } | { exhausted: number } | undefined {
  if (!decision) return undefined;
  if (decision.retrying) return { attempt: decision.attempt, at: decision.at };
  return decision.attempts > 0 ? { exhausted: decision.attempts } : undefined;
}

export class RunRetry {
  private readonly deps: RunRetryDeps;
  /** Потраченные попытки по ключу сессии: обнуляются удачным ходом. */
  private readonly spent = new Map<string, number>();
  private readonly timers = new Map<string, unknown>();

  constructor(deps: RunRetryDeps) {
    this.deps = deps;
  }

  /** Ход кончился: удачный — бюджет снова полон; упавший — повтор или отказ. */
  finished(finished: RunFinished): RetryDecision | undefined {
    const key = finished.sessionId ?? finished.chatId;
    // Сессии нет — ход умер до первого слова модели: отправляем задачу ту же.
    const options: RunOptions = finished.sessionId
      ? { ...finished.options, prompt: retryPrompt(finished.error), sessionId: finished.sessionId }
      : finished.options;
    const meta: RunMeta = {
      ...(finished.origin ? { origin: finished.origin } : {}),
      ...(finished.projectPath ? { projectPath: finished.projectPath } : {}),
      ...(finished.sessionId ? { sessionId: finished.sessionId } : {}),
    };
    return this.settle(key, finished, () => {
      if (!this.deps.start(finished.chatId, options, meta)) {
        this.deps.log('run retry: start refused', finished.chatId);
      }
    });
  }

  /**
   * То же правило для хода, который заводит не реестр (ребёнок в чужом CLI):
   * решение и таймер здесь, а чем продолжить — говорит вызывающий (`fire`).
   * Сессии у чужого CLI нет, и продолжение — реплика в тот же разговор.
   */
  settle(
    key: string,
    finished: Pick<RunFinished, 'ok' | 'error' | 'limit'>,
    fire: () => void,
  ): RetryDecision | undefined {
    if (finished.ok) {
      this.spent.delete(key);
      return undefined;
    }
    const now = (this.deps.now ?? Date.now)();
    const failure = classifyFailure(finished, now);
    const spent = this.spent.get(key) ?? 0;
    if (failure.kind === 'fatal' || spent >= MAX_ATTEMPTS) {
      this.spent.delete(key);
      return { retrying: false, attempts: spent, kind: failure.kind };
    }

    const attempt = spent + 1;
    this.spent.set(key, attempt);
    const at = failure.at ?? now + (RETRY_DELAYS_MS[spent] ?? RETRY_DELAYS_MS.at(-1)!);
    const run = (): void => {
      this.timers.delete(key);
      fire();
    };
    this.cancel(key);
    this.timers.set(key, (this.deps.schedule ?? setTimeout)(run, Math.max(0, at - now)));
    return { retrying: true, attempt, at };
  }

  /**
   * Разговор запущен кем-то ещё (человек ответил, продолжил руками) — ждущий
   * повтор больше не нужен: второй прогон поверх этого был бы двумя агентами.
   */
  started(keys: readonly string[]): void {
    for (const key of keys) this.cancel(key);
  }

  private cancel(key: string): void {
    const handle = this.timers.get(key);
    if (handle === undefined) return;
    (this.deps.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle);
    this.timers.delete(key);
  }
}

/**
 * Упавший ход ребёнка в чужом CLI (Д10) — то же правило, что у Claude. Сессии у
 * чужого CLI нет: продолжение — реплика в тот же разговор (`start` по ключу
 * дерева), история уезжает вместе с ней. Остановленный человеком ход, ход без
 * рабочего каталога и не-работа (план, разбор) не повторяются.
 */
export function retryForeignRun(
  retry: RunRetry,
  input: {
    key: string;
    cwd: string | undefined;
    ok: boolean;
    error?: string;
    stopped?: boolean;
    /** Ребёнок разделения на звене работы — см. `isRetriedChild` в bootstrap. */
    retried: boolean;
  },
  start: (key: string, options: RunOptions, meta: RunMeta) => boolean,
  log: (message: string, error?: unknown) => void,
): ReturnType<typeof retryOutcome> {
  const { key, cwd } = input;
  if (input.stopped || !cwd || !input.retried) return undefined;
  const decision = retry.settle(key, input, () => {
    const options = { prompt: retryPrompt(input.error), cwd };
    if (!start(key, options, { projectPath: cwd })) log('foreign run retry: start refused', key);
  });
  return retryOutcome(decision);
}
