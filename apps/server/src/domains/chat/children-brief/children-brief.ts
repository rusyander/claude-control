import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { localizeText } from '../../../lib/server-texts/server-texts.ts';
import { WORKSPACE_TAG } from '../workspace-note/workspace-note.ts';

/**
 * Сводка детей для хода родителя (Д6).
 *
 * После разделения в сессию родителя не попадало ничего: он не знал, что работа
 * отдана детям, и на вопрос человека «исправлено?» садился делать её сам —
 * лишний агент на ту же задачу. Теперь каждый его ход начинается с этой сводки:
 * кто что делает, где, в каком состоянии и чем кончил.
 *
 * Сводка идёт В СООБЩЕНИИ, а не в системной дописке: дописка входит в подпись
 * живого процесса, и сводка, меняющаяся от хода к ходу, перезапускала бы его —
 * вместе с фоновыми командами родителя. В ленте человеку её не показывают:
 * обёртку вырезает `stripChildrenBrief` при чтении транскрипта.
 */
const TAG = 'agentdeck-children';
const BLOCK = new RegExp(`^\\s*<${TAG}>[\\s\\S]*?</${TAG}>\\s*`);
const ANY_BLOCK = new RegExp(`<${TAG}>[\\s\\S]*?</${TAG}>\\s*`, 'g');
const WORKSPACE_BLOCK = new RegExp(`<${WORKSPACE_TAG}>[\\s\\S]*?</${WORKSPACE_TAG}>\\s*`, 'g');

/** Хвост ответа ребёнка в сводке — чтобы понять, о чём он, а не пересказ целиком. */
const TAIL_LIMIT = 240;

const STATUS: Record<SplitPlanView['groups'][number]['status'], string> = {
  pending: 'waits for the triage result',
  waiting: 'waits for its predecessors to finish',
  held: "waits for the human's answer to the triage question",
  started: 'working',
  awaiting: 'waits for the human',
  background: 'turn ended, a background command is running',
  done: 'finished',
  failed: 'failed',
  paused: 'paused — the human stopped it',
};

const WAIT: Record<NonNullable<SplitPlanView['groups'][number]['waitingFor']>, string> = {
  question: 'asked a question and waits for the answer',
  decision: 'waits for a decision on the review',
  'review-missing': 'the review ended without a summary',
  'review-follow-up': 'the panel sent the review back to finish its outcome',
  background: 'waits for a background command',
  retry: 'waits for a retry after a failure',
  delivery: 'the panel is checking the delivery against git (branch, MR)',
  interrupted: 'the process broke off mid-turn — waits to be continued',
  limit: 'hit the subscription limit — continues after the reset',
};

const RESULT: Record<NonNullable<SplitPlanView['groups'][number]['result']>['kind'], string> = {
  reviewed: 'check only, no edits',
  changed: 'edits made',
  unchanged: 'no edits in the copy',
  pushed: 'edits pushed',
  nothing: 'nothing to deliver — the task needed no edits',
};

export function childrenBrief(split: SplitPlanView | undefined): string | undefined {
  if (!split || split.groups.length === 0) return undefined;
  return [
    `<${TAG}>`,
    'The work of this conversation was handed to split groups — each has its own copy and its ' +
      'own chat. Do not do it yourself: no edits, no new copies or branches. Answer about the ' +
      'state from this summary. To tell a group something, output a block ```agentdeck:tell N``` ' +
      '(N is the group number below) with the text inside: the panel delivers it to the group ' +
      'chat at the end of your turn, and to a busy group after its turn. Answer the human in the ' +
      'language they write in.',
    ...groupLines(split),
    `</${TAG}>`,
  ].join('\n');
}

/**
 * Сводка для лёгкого чата вопросов о ходе групп (5.1 плана экономии). Строки
 * групп те же, что у родителя; шапка своя: этот чат групп не ведёт — блок
 * `agentdeck:tell` из него никуда не доставляется, и обещать его нельзя.
 * Обёртка та же, поэтому ленту чистит тот же `stripChildrenBrief`, а свежая
 * сводка каждого хода заменяет прежнюю (`withChildrenBrief`).
 */
export function statusBrief(split: SplitPlanView | undefined, at: Date): string | undefined {
  if (!split || split.groups.length === 0) return undefined;
  return [
    `<${TAG}>`,
    `The human asks about the progress of split groups working on another conversation's task ` +
      `(state as of ${at.toISOString()}). Answer from this summary; read files in a group copy ` +
      'only when the summary does not answer. You only observe: no edits, no commands that change ' +
      'anything, no messages to the groups — to steer a group the human writes in its chat or in ' +
      'the parent conversation. Answer in the language the human writes in.',
    ...groupLines(split),
    `</${TAG}>`,
  ].join('\n');
}

/** Строка на группу: где она, в каком состоянии и чем кончила. */
function groupLines(split: SplitPlanView): string[] {
  return split.groups.map((group, position) => {
    const where = [
      group.branch ? `branch ${group.branch}` : '',
      group.path ? `copy ${group.path}` : '',
      group.chatId ? `chat ${group.chatId}` : 'no chat yet',
    ].filter(Boolean);
    const state = [
      group.status === 'failed' && group.error
        ? // Ошибка — текст сервера (русский, с кодом): модели — его английская сторона.
          `${STATUS.failed}: ${localizeText(group.error, 'en')}` +
          (group.retries ? ` (the panel retried the turn: ${group.retries})` : '')
        : STATUS[group.status],
      group.waitingFor ? WAIT[group.waitingFor] : '',
      group.result
        ? RESULT[group.result.kind] +
          (group.result.commits ? `, commits: ${group.result.commits}` : '')
        : '',
    ].filter(Boolean);
    const tail = group.tail ? ` Last answer: "${defang(clip(group.tail))}"` : '';
    const title = defang(group.title);
    return `${position + 1}. "${title}" (${where.join(', ')}) — ${state.join('; ')}.${tail}`;
  });
}

/**
 * Промпт хода со свежей сводкой. Прежнюю снимаем: продолжение после паузы дерева
 * приходит со старыми параметрами, и без этого сводки копились бы одна на другой.
 */
export function withChildrenBrief(prompt: string, brief: string | undefined): string {
  const bare = prompt.replace(BLOCK, '');
  // Команда CLI (`/compact` из карточки переполнения) узнаётся, только пока
  // стоит первой: сводка перед ней превратила бы команду в обычный текст.
  if (bare.trimStart().startsWith('/')) return bare;
  return brief ? `${brief}\n\n${bare}` : bare;
}

/**
 * Текст реплики без блоков панели — то, что человек на самом деле написал: без
 * сводки детей и без перемены строки о тестах (`workspace-note.ts`).
 */
export function stripChildrenBrief(text: string): string {
  const own = text.includes(`<${TAG}>`) ? text.replace(ANY_BLOCK, '') : text;
  return own.includes(`<${WORKSPACE_TAG}>`) ? own.replace(WORKSPACE_BLOCK, '') : own;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > TAIL_LIMIT ? `…${flat.slice(-TAIL_LIMIT)}` : flat;
}

/**
 * Название и хвост пишет модель: тег панели в них (`</agentdeck-children>` в
 * ответе о самой панели) закрывал бы сводку раньше конца, и снятие сводки
 * оставляло бы её хвост в реплике (ревью B1-F15). Угловая скобка тега — похожей.
 */
function defang(text: string): string {
  return text.replace(/<(\/?agentdeck-)/gi, '‹$1');
}
