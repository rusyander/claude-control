import type { AskView } from '@agentdeck/contracts/core/task-view';
import { randomUUID7 } from '../../core-ask/core-ask.ts';
import type { CoreAskTarget, PendingAskItem, Vanished } from './telegram-answers.types.ts';

/**
 * Вопросы ядра задач в боте ответов (этап 12, D29, P188). Каждая сверка бота читает открытые
 * вопросы живых задач ядра; вопрос — ожидание с кнопками его вариантов (`key = core:<askId>`, одно
 * сообщение на вопрос — по отметке «отправлено» файла ответов). Вопрос пропал из чтения — сверка
 * правит сообщение итогом: отвечен — «Отвечено в панели», истёк или отозван — «Уже не актуально».
 *
 * Кнопки — только то, что из Telegram примет суд области ядра (`telegram-scope.ts` ядра — он и
 * решает; здесь зеркало ради честной клавиатуры): открывающие ответы точки 3, решения сверки и
 * «правка деления» не показываются, свой текст — только `ask_human`, `blocker`, `scenario-step`.
 *
 * Кнопки работают, только пока ядро признаёт этот чат владельцем (`telegram.owner` ядра равен
 * отпечатку чата бота): иначе вопрос уходит прежним текстом со ссылкой (`core-ask-delivery.ts`).
 */

/** Чтение ядра для бота: открытые вопросы, один вопрос, привязанный владелец. */
export interface CoreAsksReader {
  /** Живые задачи с их вопросами; ядра нет — исключение (сверка пропускает круг). */
  tasks(): Promise<{ taskId: string; title: string | null; asks: AskView[] }[]>;
  /** Живой вопрос задачи; `null` — его нет в виде задачи. */
  ask(taskId: string, askId: string): Promise<AskView | null>;
  /** `telegram.owner` действующей настройки ядра; `null` — не задан или настройка в дрейфе. */
  owner(): Promise<string | null>;
}

export interface CoreAsksDeps {
  reader: CoreAsksReader;
  /** Отпечаток чата бота ответов (`telegramOwnerFingerprint`); `null` — бот или владелец не заданы. */
  fingerprint: () => string | null;
  mintId?: () => string;
}

/** Где ядро принимает из Telegram свой текст вместо варианта (суд области ядра, B3). */
const FREE_TEXT_SOURCES: ReadonlySet<string> = new Set(['ask_human', 'blocker', 'scenario-step']);
/** Ответы, открывающие вызов на вопросе права, — точке 3 из Telegram нельзя. */
const OPENING = new Set(['grant', 'allow']);
/**
 * Решения сверки (`conductor/next/answers.ts` ядра, `reconcile.done/notDone` на двух языках) — их
 * из Telegram ядро не примет: судьба внешнего действия решается в панели или с телефона.
 */
const RECONCILE_SETTLE = new Set([
  'считать выполненным',
  'считать невыполненным',
  'Treat as done',
  'Treat as not done',
]);

/**
 * «Разрешить» записи в тикет, пункт 9 (`trackerWrite.approve` ядра на двух языках): ядро отпускает
 * запись только ответом панели или телефона, из Telegram суд области его отклоняет.
 */
const TRACKER_WRITE_APPROVE = new Set(['Разрешить комментарий', 'Allow the comment']);

/** Варианты вопроса, которые бот показывает кнопками: то, что примет суд области ядра. */
export function visibleOptions(ask: Pick<AskView, 'source' | 'point' | 'options'>): string[] {
  return (ask.options ?? []).filter((option) => {
    if (ask.source === 'permit' && ask.point === 3 && OPENING.has(option)) return false;
    if (ask.source === 'reconcile' && RECONCILE_SETTLE.has(option)) return false;
    if (ask.source === 'tracker-write' && TRACKER_WRITE_APPROVE.has(option)) return false;
    // «Правка деления» — экран запуска панели, команды у неё нет.
    if (ask.source === 'launch' && option === 'edit-split') return false;
    return true;
  });
}

const LABELS: Record<string, string> = {
  grant: '✅ Разрешить этот вызов',
  allow: '✅ Разрешить',
  refuse: '⛔ Отказать',
  'approve-split': '▶️ Запустить по плану',
  cancel: '✖️ Отменить задачу',
};

/** Подпись кнопки варианта: человеческая для служебных слов, иначе сам вариант. */
export function labelOf(option: string): string {
  const known = LABELS[option];
  if (known) return known;
  if (option.startsWith('model:')) return `Модель ${option.slice('model:'.length)}`;
  if (option.startsWith('cli:')) return `CLI ${option.slice('cli:'.length)}`;
  return option;
}

/** Ключ ожидания вопроса ядра: одно сообщение на `askId`. */
export const coreAskKey = (askId: string): string => `core:${askId}`;

export interface CoreAsks {
  /** Перечитать вопросы и владельца ядра; ошибка чтения — прежний список не трогается. */
  refresh(): Promise<void>;
  /** Открытые вопросы ядра — ожидания бота; пусто, пока кнопки не действуют. */
  items(): PendingAskItem[];
  /** Ядро признаёт чат бота владельцем — вопросы ядра идут кнопками, текст не нужен. */
  covers(): boolean;
  /** Почему вопрос ядра пропал: отвечен — в панели, иначе — не актуален. */
  vanished(target: CoreAskTarget): Vanished;
  /** Живой вопрос (перед отправкой команды). */
  live(target: CoreAskTarget): Promise<AskView | null>;
  /** Новый ключ повтора для слота: прежний ядро записало отказом. */
  remint(target: CoreAskTarget, slot: number): void;
}

interface Known {
  taskId: string;
  title: string | null;
  ask: AskView;
}

export function createCoreAsks(deps: CoreAsksDeps): CoreAsks {
  const mint = deps.mintId ?? randomUUID7;
  let open = new Map<string, Known>();
  /** Последнее известное состояние вопросов, ушедших из открытых, — для строки итога. */
  const closed = new Map<string, AskView['state']>();
  /** Ключи повтора по вопросу: держатся, пока вопрос открыт, — повтор нажатия шлёт те же. */
  const cmdIds = new Map<string, string[]>();
  let bound = false;

  const slotsOf = (ask: AskView): string[] => {
    const have = cmdIds.get(ask.askId);
    const need = visibleOptions(ask).length + 1;
    if (have && have.length === need) return have;
    const fresh = Array.from({ length: need }, (_, at) => have?.[at] ?? mint());
    cmdIds.set(ask.askId, fresh);
    return fresh;
  };

  return {
    async refresh() {
      const fingerprint = deps.fingerprint();
      const owner = fingerprint ? await deps.reader.owner() : null;
      bound = fingerprint !== null && owner === fingerprint;
      if (!bound) return;
      const next = new Map<string, Known>();
      for (const task of await deps.reader.tasks()) {
        for (const ask of task.asks) {
          if (ask.state === 'open') next.set(ask.askId, { ...task, ask });
          else if (open.has(ask.askId)) closed.set(ask.askId, ask.state);
        }
      }
      for (const askId of open.keys()) {
        if (!next.has(askId) && !closed.has(askId)) closed.set(askId, 'withdrawn');
      }
      open = next;
    },
    items() {
      if (!bound) return [];
      return [...open.values()].map(({ taskId, title, ask }) => {
        const options = visibleOptions(ask);
        const question = ask.question ?? '';
        const target: CoreAskTarget = {
          kind: 'coreAsk',
          taskId,
          askId: ask.askId,
          cmdIds: slotsOf(ask),
          question,
          freeText: FREE_TEXT_SOURCES.has(ask.source),
          // Часть вариантов скрыта — сообщение называет, где их выбрать (D29).
          ...(options.length < (ask.options ?? []).length ? { panelOnly: true } : {}),
        };
        return {
          key: coreAskKey(ask.askId),
          target,
          openId: '',
          source: { project: title ?? 'Задача ядра', chatTitle: '', cli: '', app: 'agentdeck' },
          askedAt: new Date().toISOString(),
          // Вопрос ядра уже ждёт человека: ядро само решает, когда спросить, — без отсрочки.
          immediate: true,
          // Действие по умолчанию (P153) — вопрос неблокирующий, тихие часы его держат (Z17).
          ...(ask.defaultAction ? { defaultAction: ask.defaultAction } : {}),
          questions: [
            {
              question,
              options: options.map((option) => ({ label: labelOf(option) })),
            },
          ],
        };
      });
    },
    covers: () => bound,
    vanished(target) {
      // Привязку сняли, а вопрос ждёт: ответить на него теперь можно только в панели или с телефона.
      if (!bound && open.has(target.askId)) return { kind: 'coreOnly' };
      const state = closed.get(target.askId);
      return state === 'answered' ? { kind: 'inPanel' } : { kind: 'stale' };
    },
    async live(target) {
      const ask = await deps.reader.ask(target.taskId, target.askId);
      if (ask && ask.state !== 'open') closed.set(ask.askId, ask.state);
      return ask;
    },
    remint(target, slot) {
      const slots = cmdIds.get(target.askId) ?? [...target.cmdIds];
      slots[slot] = mint();
      cmdIds.set(target.askId, slots);
      target.cmdIds = [...slots];
    },
  };
}
