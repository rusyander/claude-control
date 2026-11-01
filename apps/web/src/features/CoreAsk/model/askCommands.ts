import type { CommandDraft } from '@entities/CoreTask';
import type { AskCardAsk, AskChoice } from './askCommands.types';

/**
 * Выбор человека на карточке вопроса → команды ядра (P23: ответ — только командой с числом
 * страницы, панель журнал не пишет). Почти всё — `answer` с текстом варианта; особые варианты:
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

/** Глобы гранта из поля «по одному в строке»: пустые строки и пробелы по краям — не пути. */
export function globsOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((g) => g.trim())
    .filter(Boolean);
}
