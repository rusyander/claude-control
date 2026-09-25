import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';

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
  pending: 'ждёт итога разбора',
  waiting: 'ждёт конца предшественников',
  held: 'ждёт ответа человека на вопрос разбора',
  started: 'работает',
  awaiting: 'ждёт человека',
  background: 'ход кончился, идёт фоновая команда',
  done: 'закончила',
  failed: 'сбой',
  paused: 'на паузе — её остановил человек',
};

const WAIT: Record<NonNullable<SplitPlanView['groups'][number]['waitingFor']>, string> = {
  question: 'задала вопрос и ждёт ответа',
  decision: 'ждёт решения по ревью',
  'review-missing': 'ревью кончилось без итога',
  background: 'ждёт фоновую команду',
  retry: 'ждёт повтора после сбоя',
  delivery: 'панель проверяет доставку по git (ветка, MR)',
  interrupted: 'процесс оборвался посреди хода — ждёт продолжения',
  limit: 'упёрлась в лимит подписки — продолжится после сброса',
};

const RESULT: Record<NonNullable<SplitPlanView['groups'][number]['result']>['kind'], string> = {
  reviewed: 'только проверка, правок не было',
  changed: 'правки внесены',
  unchanged: 'правок в копии нет',
  pushed: 'правки отправлены',
};

export function childrenBrief(split: SplitPlanView | undefined): string | undefined {
  if (!split || split.groups.length === 0) return undefined;
  const lines = split.groups.map((group, position) => {
    const where = [
      group.branch ? `ветка ${group.branch}` : '',
      group.path ? `копия ${group.path}` : '',
      group.chatId ? `чат ${group.chatId}` : 'чата ещё нет',
    ].filter(Boolean);
    const state = [
      group.status === 'failed' && group.error
        ? `${STATUS.failed}: ${group.error}` +
          (group.retries ? ` (панель повторяла ход: ${group.retries})` : '')
        : STATUS[group.status],
      group.waitingFor ? WAIT[group.waitingFor] : '',
      group.result
        ? RESULT[group.result.kind] +
          (group.result.commits ? `, коммитов: ${group.result.commits}` : '')
        : '',
    ].filter(Boolean);
    const tail = group.tail ? ` Последний ответ: «${clip(group.tail)}»` : '';
    return `${position + 1}. «${group.title}» (${where.join(', ')}) — ${state.join('; ')}.${tail}`;
  });
  return [
    `<${TAG}>`,
    'Работа этого разговора отдана группам разделения — у каждой своя копия и свой чат. ' +
      'Сам её не делай: ни правок, ни новых копий и веток. О состоянии отвечай по этой ' +
      'сводке. Нужно что-то сказать группе — выведи блок ```agentdeck:tell N``` (N — номер ' +
      'группы ниже) с текстом внутри: панель доставит его в чат группы в конце твоего ' +
      'хода, а занятой группе — после её хода.',
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
