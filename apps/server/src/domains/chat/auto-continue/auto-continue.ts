import type { RunOptions } from '../ChatRunner/ChatRunner.ts';
import type { RunFinished, RunMeta } from '../ChatRunRegistry/ChatRunRegistry.ts';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import { isRetriableRunError } from '../run-errors/run-errors.ts';

/**
 * Продолжение обычного чата на локальной модели после обрыва (L4b).
 *
 * Цель владельца: ночная задача на локальной Qwen не умирает сама — она кончается, когда
 * сделана или когда нужен человек. Присмотр за сервером (`supervisor.ts`) поднимает упавший
 * llama-server, а Claude Code после «перегрузки» повторяет запрос ~2,7 минуты и сдаётся: ход
 * кончается ошибкой, и чат стоит до утра. Надзор повторов (`run-retry.ts`) ведёт только детей
 * разделения; обычный чат оставался без присмотра.
 *
 * Правило. Ход локального чата кончился обрывом, который лечится продолжением (сеть, 5xx,
 * «перегрузка», процесс умер без итога, исчерпанные повторы, «автосжатие буксует», предел
 * вывода, окно переполнено), — через паузу в ТОТ ЖЕ разговор уходит сообщение «продолжай с
 * места остановки; состояние — в PROGRESS.md». Не больше `CONTINUE_MAX` раз подряд, паузы
 * растут. Никогда: после нормального конца, после вопроса человеку, после обрыва по
 * существу (ключ, запрос, отказ запуска) и после остановки человеком (она сюда не приходит).
 * Сообщение человека обнуляет счёт и снимает ждущее продолжение.
 *
 * Чего нет. Чужие CLI (Qwen Code): их ход заводит `ProviderChatService` с набором
 * зависимостей запуска, и продолжение туда — отдельная работа. Ждущее продолжение живёт в
 * памяти процесса: перезапуск панели его теряет (ход, который шёл, усыновляется заново).
 */

export const CONTINUE_MAX = 3;
/**
 * Сколько инструментов должно отработать в продолженном ходе, чтобы считать, что он двигал
 * задачу: тогда следующий обрыв — новый сбой, а не продолжение прежнего, и счёт начинается заново.
 */
export const PROGRESS_TOOL_RESULTS = 3;
/** Паузы перед продолжениями: сервер успевает подняться, видеокарта — освободиться. */
export const CONTINUE_DELAYS_MS = [20_000, 60_000, 180_000] as const;

/** Обрывы, которые лечит продолжение, помимо временных сетевых (`isRetriableRunError`). */
const CONTEXT_FAILURES =
  /Autocompact is thrashing|output token maximum|context window limit|prompt is too long|Repeated 529/i;

/** Процесс CLI закрылся ненулевым кодом, не назвав причины: убит, упал, потерял сеть. */
const PROCESS_DIED = /завершился с кодом/;

export interface ContinueVerdict {
  recoverable: boolean;
  /** Причина обрыва — как её назвал CLI; пусто, когда продолжать нечего. */
  reason: string;
}

/**
 * Лечится ли этот конец прогона продолжением. Нормальный конец, вопрос человеку, обрыв
 * усыновлённого процесса и лимит подписки — нет: первое закончено, второе ждёт человека,
 * третье продолжает конвейер, четвёртого у локальной модели не бывает.
 */
export function classifyEnd(
  finished: Pick<RunFinished, 'ok' | 'error' | 'asked' | 'interrupted' | 'text'>,
): ContinueVerdict {
  const none = { recoverable: false, reason: '' };
  if (finished.ok || finished.asked) return none;
  // Усыновлённый процесс умер, не дописав ход: ночью это обрыв, который лечится продолжением
  // той же сессии (дальше решает вызывающий: только локальный прогон и не ход конвейера).
  if (finished.interrupted) return { recoverable: true, reason: serverText('chat-process-lost') };
  const error = finished.error ?? '';
  if (!error) return none;
  // Модель закончила вопросом и упала на закрытии хода — ждёт ответа человека, а не «продолжай».
  if (/\?\s*$/.test(finished.text.trim())) return none;
  const recoverable =
    PROCESS_DIED.test(error) ||
    error === serverText('chat-process-lost') ||
    CONTEXT_FAILURES.test(error) ||
    isRetriableRunError(error);
  return recoverable ? { recoverable, reason: error } : none;
}

/** Сообщение, которое уходит сессии: человек читает его в ленте, модель — как просьбу. */
export function continuePrompt(reason: string): string {
  const why = reason ? ` Прошлый ход оборвался: ${reason.replace(/\s+/g, ' ').slice(0, 200)}.` : '';
  return (
    '[Автоматически] Продолжай задачу с места остановки; состояние — в .agent/PROGRESS.md. ' +
    `Если файла нет — восстанови по рабочей папке и по этой переписке.${why}`
  );
}

export type ContinueDecision =
  | { continuing: true; attempt: number; delayMs: number; reason: string }
  | { continuing: false; attempts: number; reason: string };

export interface AutoContinueDeps {
  /** Завести прогон; `false` — реестр отказал (разговор уже идёт). */
  start: (chatId: string, options: RunOptions, meta: RunMeta) => boolean;
  /** Прогон шёл на локальной модели: у облака обрыв чинит человек или лимит. */
  isLocal: (finished: RunFinished) => boolean;
  schedule?: (run: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  log: (message: string, error?: unknown) => void;
}

export class AutoContinue {
  private readonly deps: AutoContinueDeps;
  /** Потраченные продолжения по разговору: обнуляются человеком и удачным ходом. */
  private readonly spent = new Map<string, number>();
  private readonly timers = new Map<string, unknown>();
  /** Разговоры, чей старт сейчас наш: слушатель стартов не должен принять его за слово человека. */
  private readonly own = new Set<string>();
  /** Разговор известен и по номеру сессии: человек пишет в него тем же sessionId, а chatId клиента бывает другим. */
  private readonly alias = new Map<string, string>();

  constructor(deps: AutoContinueDeps) {
    this.deps = deps;
  }

  /**
   * Ход кончился: решение — будет продолжение (и через сколько) или счёт исчерпан.
   * `planned` — конвейер уже назначил этому ходу своё продолжение: второго таймера не заводим
   * (он запустил бы второго агента в тот же разговор), но удачный конец счёт всё равно сбрасывает.
   */
  finished(finished: RunFinished, planned = false): ContinueDecision | undefined {
    const key = finished.chatId;
    if (!this.deps.isLocal(finished)) return undefined;
    if (finished.ok) {
      this.spent.delete(key);
      return undefined;
    }
    if (planned) return undefined;
    const verdict = classifyEnd(finished);
    if (!verdict.recoverable) return undefined;

    // Продолженный ход успел поработать — это новый сбой после здоровой работы, а не тот же
    // обрыв: три «моргания» за ночь, между которыми шли часы, предел не исчерпывают.
    if ((finished.toolResults ?? 0) >= PROGRESS_TOOL_RESULTS) this.spent.delete(key);
    const spent = this.spent.get(key) ?? 0;
    if (spent >= CONTINUE_MAX)
      return { continuing: false, attempts: spent, reason: verdict.reason };

    const attempt = spent + 1;
    const delayMs = CONTINUE_DELAYS_MS[spent] ?? CONTINUE_DELAYS_MS.at(-1) ?? 0;
    this.spent.set(key, attempt);
    if (finished.sessionId) this.alias.set(finished.sessionId, key);
    // Сессии нет — ход умер до первого слова модели: продолжать нечем, уходит прежняя задача.
    const options: RunOptions = finished.sessionId
      ? {
          ...finished.options,
          prompt: continuePrompt(verdict.reason),
          sessionId: finished.sessionId,
          // Упавший первый ход ветки возобновляет её сессию, а не ветвит ещё раз.
          fork: false,
        }
      : finished.options;
    const meta: RunMeta = {
      ...(finished.origin ? { origin: finished.origin } : {}),
      ...(finished.projectPath ? { projectPath: finished.projectPath } : {}),
      ...(finished.sessionId ? { sessionId: finished.sessionId } : {}),
    };
    this.cancel(key);
    this.timers.set(
      key,
      (this.deps.schedule ?? setTimeout)(() => {
        this.timers.delete(key);
        this.own.add(key);
        const started = this.deps.start(finished.chatId, options, meta);
        if (!started) {
          this.own.delete(key);
          this.deps.log('auto continue: start refused', key);
        }
      }, delayMs),
    );
    return { continuing: true, attempt, delayMs, reason: verdict.reason };
  }

  /**
   * Разговор запущен: наше собственное продолжение счёта не трогает, слово человека (или
   * любой другой старт) снимает ждущее продолжение и обнуляет счёт — человек вернулся.
   */
  started(keys: readonly string[]): void {
    const conversations = [...new Set(keys.map((key) => this.alias.get(key) ?? key))];
    const own = conversations.find((key) => this.own.has(key));
    if (own !== undefined) {
      this.own.delete(own);
      return;
    }
    for (const key of conversations) {
      this.cancel(key);
      this.spent.delete(key);
    }
  }

  private cancel(key: string): void {
    const handle = this.timers.get(key);
    if (handle === undefined) return;
    (this.deps.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle);
    this.timers.delete(key);
  }
}

/** Текст ленты о принятом решении: человек видит, что чат продолжит сам, и почему. */
export function continueNotice(decision: ContinueDecision): {
  code: 'autoContinue' | 'autoContinueSpent';
  textCode: 'chat-auto-continue-notice' | 'chat-auto-continue-spent-notice';
  params: Record<string, string>;
} {
  const reason = decision.reason.replace(/\s+/g, ' ').slice(0, 160);
  return decision.continuing
    ? {
        code: 'autoContinue',
        textCode: 'chat-auto-continue-notice',
        params: {
          attempt: String(decision.attempt),
          max: String(CONTINUE_MAX),
          seconds: String(Math.round(decision.delayMs / 1000)),
          reason,
        },
      }
    : {
        code: 'autoContinueSpent',
        textCode: 'chat-auto-continue-spent-notice',
        params: { max: String(CONTINUE_MAX), reason },
      };
}
