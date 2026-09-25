import type { ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import type { ChildStageGroup } from '../ui/ChildStages.types';

/**
 * Сводка хаба одной строкой (L37): сколько групп готово, идёт, ждёт человека,
 * стоит в очереди, упало — и сколько идёт всё разделение.
 *
 * Живой прогон 24.09.2026: через два часа человек не мог сказать, закончена ли
 * хоть одна группа, — пришлось читать одиннадцать строк подряд. Счётчики
 * отвечают на это за секунду, а «ждёт вас» — на главный вопрос: нужен ли я.
 *
 * Каждая группа ложится ровно в одну корзину, и порядок проверок — порядок
 * правды. Идущий прогон — первым: сервер помнит «упала» или «готово» с прошлого
 * хода, а панель уже повторила ход, и группа снова работает. Строка разбора и
 * отброшенные перезапуском чаты — не группы, они не считаются.
 */
export type HubBucket =
  'accepted' | 'done' | 'running' | 'ask' | 'queued' | 'failed' | 'cancelled' | 'idle';

/** Код закрытия группы отменой плана (`split-conveyor` → `cancel`). */
const PLAN_CANCELLED = 'split-group-plan-cancelled';

export const HUB_BUCKETS: readonly HubBucket[] = [
  'accepted',
  'done',
  'running',
  'ask',
  'queued',
  'failed',
  'cancelled',
  'idle',
];

export interface HubSummary {
  counts: Record<HubBucket, number>;
  /** Сколько идёт разделение (мс): от первого звена до «сейчас» или до последней записи. */
  elapsedMs?: number;
}

/** Строка разбора — общая на всё разделение, группой она не считается. */
export function isTriageRow(group: ChildStageGroup): boolean {
  return group.stages.includes('triage');
}

/** Строки, которые считаются группами: без разбора и без отброшенных чатов. */
export function countedGroups(groups: ChildStageGroup[]): ChildStageGroup[] {
  return groups.filter((group) => !group.retired && !isTriageRow(group));
}

export function hubBucket(group: ChildStageGroup): HubBucket {
  if (group.isRunning) return 'running';
  // Закрыта отменой плана — решение человека, а не сбой: рядом со строкой
  // «остановлена: план отменён человеком» фишка писала «упала» (живой прогон 26.09, O3).
  if (group.errorCode === PLAN_CANCELLED) return 'cancelled';
  if (group.pending === 'failed' || group.status === 'failed') return 'failed';
  if (
    group.pending === 'held' ||
    group.waitingFor === 'question' ||
    group.waitingFor === 'decision'
  ) {
    return 'ask';
  }
  // Принятая человеком — своя корзина (TK-accepted): «готово» говорит, что
  // панель довела группу, «принято» — что человек её посмотрел.
  if (group.status === 'done' && group.acceptance?.acceptedAt) return 'accepted';
  if (group.status === 'done') return 'done';
  if (group.pending) return 'queued';
  // Чат есть, прогона нет, итога нет: ждёт фон, повтор, доставку или просто
  // остановлен. Это не «готово» и не «ждёт вас» — корзина своя.
  return 'idle';
}

/**
 * Счётчики и время. Время — от самого раннего звена (обычно разбора) до
 * «сейчас», пока хоть что-то идёт; когда всё стоит — до последней записи:
 * иначе остановленное разделение «шло» бы вечно.
 */
export function summarizeHub(groups: ChildStageGroup[], now: number): HubSummary {
  const counts: Record<HubBucket, number> = {
    accepted: 0,
    done: 0,
    running: 0,
    ask: 0,
    queued: 0,
    failed: 0,
    cancelled: 0,
    idle: 0,
  };
  for (const group of countedGroups(groups)) counts[hubBucket(group)] += 1;

  const live = groups.filter((group) => !group.retired);
  const starts = live.map((group) => Date.parse(group.startedAt ?? '')).filter(Number.isFinite);
  if (starts.length === 0) return { counts };
  const start = Math.min(...starts);
  const lasts = live.map((group) => Date.parse(group.lastAt ?? '')).filter(Number.isFinite);
  const end = live.some((group) => group.isRunning) ? now : Math.max(start, ...lasts);
  return { counts, elapsedMs: Math.max(0, end - start) };
}

/**
 * Сколько идёт разбор (L13): он молчит минутами, и без времени его не отличить
 * от зависшего. Только у ИДУЩЕГО прогона разбора: у остановленного «идёт 20м»
 * было бы той же ложью, что и «в работе» (L23).
 */
export function triageElapsedMs(groups: ChildStageGroup[], now: number): number | undefined {
  const triage = groups.find((group) => !group.retired && isTriageRow(group));
  if (!triage?.isRunning || !triage.startedAt) return undefined;
  const start = Date.parse(triage.startedAt);
  return Number.isFinite(start) ? Math.max(0, now - start) : undefined;
}

/**
 * Идёт ли прогон разбора прямо сейчас: строка разбора в хабе или его узел в
 * дереве сервера. Дерево нужно, потому что строки разбора может и не быть (чат
 * ещё не доехал до списка, лента чужого CLI), а знать, идёт ли он, фишке надо
 * всегда: «идёт разбор» над стоящим деревом — та же ложь, что «в работе» (L23).
 */
export function triageLive(groups: ChildStageGroup[], tree: ChatTreeView | undefined): boolean {
  if (groups.some((group) => !group.retired && isTriageRow(group) && group.isRunning)) return true;
  const triageChatId = tree?.split?.triageChatId;
  if (!triageChatId) return false;
  return (tree?.nodes ?? []).some(
    (node) => node.running && (node.chatId === triageChatId || node.aliases.includes(triageChatId)),
  );
}
