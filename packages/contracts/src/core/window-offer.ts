import type { CommandDraft } from './ask-commands.ts';
import type { TaskView } from './task-view.ts';

/**
 * Карточка окна (этап 12, P184, P192): варианты перевода начатой задачи и команда клика. Один модуль
 * на панель и бот Telegram — кнопка шлёт ровно `offerCommand`, где бы её ни нажали. Только типы на
 * импорт: модуль без зависимостей во время выполнения.
 */

/** Вариант перевода начатой задачи (P169): `cli:<переходник>` или `model:<id>` из `tier.offers`. */
export interface WindowOffer {
  option: string;
  kind: 'cli' | 'model';
  value: string;
}

/** Варианты вида задачи; строка не той формы — не вариант (ядро пишет только эти две). */
export function offersOf(view: TaskView): WindowOffer[] {
  const out: WindowOffer[] = [];
  for (const option of view.windowWait?.offers ?? []) {
    const m = /^(cli|model):(.+)$/.exec(option);
    if (m?.[2]) out.push({ option, kind: m[1] === 'cli' ? 'cli' : 'model', value: m[2] });
  }
  return out;
}

/**
 * Клик по варианту → правка задачи сразу (P184): `set-cli` с переходником или `set-model` без
 * усилия — усилие остаётся тем, что решит суд маршрута. Область — сама задача.
 */
export function offerCommand(taskId: string, offer: WindowOffer): CommandDraft {
  const base = { scope: 'task', scopeId: taskId, timing: 'now' } as const;
  return offer.kind === 'cli'
    ? { kind: 'set-cli', taskId, fields: { ...base, adapter: offer.value } }
    : { kind: 'set-model', taskId, fields: { ...base, model: offer.value, effort: null } };
}

/**
 * Открыт вопрос точки 7 об исчерпании этого шага: варианты перевода — его ответы (`answer`
 * `cli:…`, правка ссылается на вопрос), карточка окна кнопок не дублирует.
 */
export function askHoldsOffers(view: TaskView): boolean {
  const wait = view.windowWait;
  if (!wait) return false;
  return view.asks.some(
    (a) =>
      a.state === 'open' &&
      a.dedupe?.startsWith('exhausted:') === true &&
      (wait.stepId === null || a.stepId === wait.stepId),
  );
}
