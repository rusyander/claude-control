import type { SplitPlanGroupRecord, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { localizeText } from '../../lib/server-texts/server-texts.ts';

/**
 * «Продолжить» человека в строке группы (владелец, 05.10.2026) — группе, которая
 * остановилась недоделанной: сдалась на сбое (живой прогон: доступ CLI кончился,
 * повторы исчерпаны, и строка осталась без единой кнопки) или кончила ход без
 * вердикта ревью. Задание одно на все причины — восстановить состояние по фактам
 * и доделать до конца. Отдельно от `split-recheck.ts`: конвейер зовёт это сам, а
 * перепроверка зовёт конвейер — в одном модуле был цикл импортов.
 */

/** Задание группе, остановившейся недоделанной. Причина — английской стороной текста. */
export function continuePrompt(input: {
  branch: string;
  deliver: boolean;
  error?: string;
}): string {
  const cause = input.error ? `: ${localizeText(input.error, 'en').slice(0, 300)}` : '';
  return [
    `The human asks the group to continue: its work is not finished (the last turn stopped${cause}).`,
    'First restore the state from the facts: git status, git log, the MR of the branch if there ' +
      'is one, your transcript — what is done and what is not; run the interrupted checks again.',
    `Then finish the group's tasks on the branch ${input.branch}.` +
      (input.deliver
        ? ' Deliver as agreed: commit, push the branch, open the MR (or update the existing one) ' +
          'and give its link as the last line.'
        : ' Finish with a short summary of what was done.'),
    'If what stopped the work is outside your reach (no access, not logged in, the decision is ' +
      "the human's) — ask the human with a question, not a report.",
  ].join('\n');
}

/**
 * Вводная группе, чей разговор продолжить нельзя: файла сессии на диске нет
 * (удалён мимо панели — вопрос ревью Q2). Ход идёт новым разговором в той же
 * копии, и без этой вводной агент не знал бы ни ветки, ни своих задач.
 */
export function lostConversationBrief(
  group: Pick<SplitPlanGroupRecord, 'branch' | 'mr'>,
  tasks: readonly string[],
): string {
  return [
    'The panel could not continue your previous conversation in this folder: its transcript is ' +
      'gone (deleted outside the panel). This is a new conversation — restore the context from ' +
      `the facts: git status, git log of the branch ${group.branch}` +
      (group.mr ? `, the MR ${group.mr}.` : '.'),
    ...(tasks.length > 0 ? ["The group's tasks:", ...tasks.map((task) => `- ${task}`)] : []),
  ].join('\n');
}

/** Первая строка вводной нового разговора вместо остывшего — общая для всех стадий. */
export const COLD_RESUME_INTRO =
  'The panel started a new conversation instead of continuing the previous one: it stood idle ' +
  'past its prompt cache lifetime, and continuing would have written the whole window again at ' +
  'full price. The panel collected the facts below from your copy — start from them.';

/**
 * Вводная группе, чей разговор панель НЕ продолжает намеренно (`coldResume`):
 * кэш остыл, и продолжение заново записало бы всё окно. Факты (заметки, git,
 * последний ответ, путь к транскрипту) дописывает запуск — он знает копию и файл.
 */
export function coldResumeBrief(
  group: Pick<SplitPlanGroupRecord, 'branch' | 'mr'>,
  tasks: readonly string[],
): string {
  return [
    COLD_RESUME_INTRO,
    `Branch ${group.branch}` + (group.mr ? `, MR ${group.mr}.` : '.'),
    ...(tasks.length > 0 ? ["The group's tasks:", ...tasks.map((task) => `- ${task}`)] : []),
  ].join('\n');
}

/** Группа, которой «Продолжить» по делу: остановилась недоделанной и есть где продолжать. */
export function continuable(record: SplitPlanRecord, group: SplitPlanGroupRecord): boolean {
  if (record.cancelledAt || !group.chatId || !group.path || group.cleaned) return false;
  // «Убрать» — без возврата (ревью R3).
  if (group.droppedAt) return false;
  return (
    group.status === 'failed' ||
    (group.status === 'awaiting' && group.waitingFor === 'review-missing')
  );
}
