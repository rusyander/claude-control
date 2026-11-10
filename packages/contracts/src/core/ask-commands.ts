import type { CommandEnvelope, CommandKind } from './commands.ts';
import type { GRANT_OPS, HumanAskSource } from './journal.ts';

/**
 * Выбор человека на карточке вопроса ядра → команды ядра (P23, P188). Один модуль на все карточки:
 * панель, бот Telegram и телефон шлют ровно те же команды — иначе одна кнопка значила бы разное в
 * разных местах. Только типы на импорт: модуль без зависимостей во время выполнения.
 */

/** Черновик команды: вид, задача и поля; доказательство и `cmdId` ставит отправитель. */
export interface CommandDraft {
  kind: CommandKind;
  taskId: string;
  fields: CommandEnvelope['fields'];
  /** Номер строки, на которую смотрел человек: ядро откажет, если задача ушла дальше. */
  expectSeq?: number;
  /** Подпись устройства (телефон), если команда строгая и пир не подтверждён. */
  signature?: string;
  /**
   * Ключ повтора, который держит вызывающий: повтор с тем же `cmdId` ядро не исполняет второй раз,
   * а отдаёт сохранённый исход (P47). Нет — новый ключ на каждую отправку.
   */
  cmdId?: string;
}

export type GrantOp = (typeof GRANT_OPS)[number];

/** Вопрос, как его видит карточка: факты вопроса из ленты или из вида задачи (структурно совпадают). */
export interface AskCardAsk {
  askId: string;
  point: number;
  source: HumanAskSource;
  question: string;
  options: string[];
  defaultAction: string | null;
  /** Деление вопроса запуска — для `approve-split`. */
  splitId: string | null;
  /** Цель отказа права — путь гранта по умолчанию. */
  permit: { action: string; target: string } | null;
  /** Репозиторий шага — проект гранта по умолчанию. */
  repoKey: string | null;
}

export type AskChoice =
  | { type: 'option'; option: string; cancelReason: string }
  | { type: 'text'; text: string }
  | { type: 'grant'; project: string; globs: string[]; ops: GrantOp[] };

/**
 * Почти всё — `answer` с текстом варианта; особые варианты:
 * - вопрос запуска (пункт 10, ключ `split:<id>`): «approve-split» — команда `approve-split` по
 *   делению, «cancel» — отмена задачи, «edit-split» — правка на экране запуска (команды нет);
 * - вопрос права (пункт 5) с вариантом «grant»: сначала `grant` (проект, пути, действия), затем
 *   `answer grant` — ядро продолжает шаг, только увидев выданное право.
 * `null` — у выбора нет команды, карточка показывает подсказку.
 */
export function commandsFor(
  taskId: string,
  ask: AskCardAsk,
  choice: AskChoice,
): CommandDraft[] | null {
  const answer = (text: string): CommandDraft => ({
    kind: 'answer',
    taskId,
    fields: { askId: ask.askId, answer: text },
  });
  switch (choice.type) {
    case 'text':
      return choice.text.trim() ? [answer(choice.text.trim())] : null;
    case 'grant':
      if (!choice.project.trim() || choice.globs.length === 0 || choice.ops.length === 0) {
        return null;
      }
      return [
        {
          kind: 'grant',
          taskId,
          fields: { project: choice.project.trim(), globs: choice.globs, ops: choice.ops },
        },
        answer('grant'),
      ];
    case 'option':
      if (ask.source === 'launch') {
        if (choice.option === 'approve-split' && ask.splitId) {
          return [{ kind: 'approve-split', taskId, fields: { splitId: ask.splitId } }];
        }
        if (choice.option === 'cancel') {
          return [{ kind: 'cancel', taskId, fields: { reason: choice.cancelReason } }];
        }
        if (choice.option === 'edit-split') return null;
      }
      return [answer(choice.option)];
  }
}

/**
 * Вариант перевода начатой задачи на точке 7 (P169): ядро пишет `model:<id>` или `cli:<id>`,
 * ответ уходит этим же текстом. Другой вариант — `null`.
 */
export function switchOf(option: string): { kind: 'model' | 'cli'; value: string } | null {
  const m = /^(model|cli):(.+)$/.exec(option);
  if (!m?.[2]) return null;
  return { kind: m[1] === 'cli' ? 'cli' : 'model', value: m[2] };
}

/** Глобы гранта из поля «по одному в строке»: пустые строки и пробелы по краям — не пути. */
export function globsOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((g) => g.trim())
    .filter(Boolean);
}
