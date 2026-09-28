import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { localizeText } from '../../lib/server-texts.ts';

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
};

export function childrenBrief(split: SplitPlanView | undefined): string | undefined {
  if (!split || split.groups.length === 0) return undefined;
  const lines = split.groups.map((group, position) => {
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
    const tail = group.tail ? ` Last answer: "${clip(group.tail)}"` : '';
    return `${position + 1}. "${group.title}" (${where.join(', ')}) — ${state.join('; ')}.${tail}`;
  });
  return [
    `<${TAG}>`,
    'The work of this conversation was handed to split groups — each has its own copy and its ' +
      'own chat. Do not do it yourself: no edits, no new copies or branches. Answer about the ' +
      'state from this summary. To tell a group something, output a block ```agentdeck:tell N``` ' +
      '(N is the group number below) with the text inside: the panel delivers it to the group ' +
      'chat at the end of your turn, and to a busy group after its turn. Answer the human in the ' +
      'language they write in.',
    ...lines,
    `</${TAG}>`,
  ].join('\n');
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

/** Текст реплики без сводки — то, что человек на самом деле написал. */
export function stripChildrenBrief(text: string): string {
  return text.includes(`<${TAG}>`) ? text.replace(ANY_BLOCK, '') : text;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > TAIL_LIMIT ? `…${flat.slice(-TAIL_LIMIT)}` : flat;
}
