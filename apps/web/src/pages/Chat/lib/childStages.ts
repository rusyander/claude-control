import type { ChatSummary } from '@agentdeck/contracts';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { CASCADE_STAGES, type CascadeStage } from '@agentdeck/contracts/model-cascade';
import type { ActiveRunView } from '@shared/lib/agent-runs';
import type { ChildStageGroup } from '@features/ChatMessages';

/**
 * Сводка «кто на чём работает» для родительского разговора.
 *
 * Разделение развело работу по группам, а конвейер подбора модели добавил
 * каждой группе до четырёх разговоров: план, работа, её проверка на потолке,
 * правки по замечаниям — плюс один разбор на всё разделение. В списке чатов
 * это полтора десятка строк на три группы, и по ним не прочесть главного — на
 * каком звене группа стоит СЕЙЧАС и чем оно ведётся.
 *
 * Поэтому сводка считается по ГРУППАМ, а не по чатам: звенья одной группы живут
 * в одной копии и в одной ветке, ветка их и объединяет. Ветки нет (делили не
 * репозиторий — дети работают в общем каталоге) — группу держит вместе связь
 * через заголовок, под которым её завело разделение.
 *
 * Показывается ПОСЛЕДНЕЕ звено группы: оно и есть её нынешнее состояние, а
 * пройденные подписаны рядом, чтобы был виден путь. Порядок внутри группы — по
 * времени заведения разговора: панель заводит звенья строго друг за другом, и
 * это единственный порядок, в котором они бывают.
 *
 * Конвейер уровней (Т1) добавляет то, чего в списке чатов нет вовсе: группы,
 * у которых чата ЕЩЁ НЕТ, — они ждут разбора, предшественников или ответа
 * человека. Их строки идут из вида конвейера (`split`), в его порядке старта;
 * разбор — первой строкой, он общий.
 */
export function collectChildStages(
  chats: ChatSummary[],
  parentChatId: string | undefined,
  runs: ActiveRunView[],
  split?: SplitPlanView,
): ChildStageGroup[] {
  if (!parentChatId) return [];

  const children = chats.filter((chat) => chat.parentId === parentChatId);
  if (children.length === 0 && !split) return [];

  // Ключ группы — ветка; без неё имя группы из связи. Заголовок чата ключом не
  // годится: это текст его первого сообщения, а он у работы, её ревью и правок
  // разный — три звена одной группы разъехались бы по трём строкам.
  const groups = new Map<string, ChatSummary[]>();
  for (const chat of children) {
    const key = chat.branch || chat.groupTitle || chat.id;
    const list = groups.get(key);
    if (list) list.push(chat);
    else groups.set(key, [chat]);
  }

  const byKey = new Map<string, ChildStageGroup>();
  for (const [key, list] of groups) {
    const row = groupRow(key, list, runs);
    if (row) byKey.set(key, row);
  }
  if (!split) return [...byKey.values()];

  // Порядок конвейера: разбор, потом группы как он их выстроил, потом всё, что
  // в конвейере не значится (чаты старше него или заведённые руками).
  const ordered: ChildStageGroup[] = [];
  const taken = new Set<string>();
  const take = (key: string | undefined): void => {
    if (!key || taken.has(key)) return;
    const row = byKey.get(key);
    if (!row) return;
    taken.add(key);
    ordered.push(row);
  };

  take([...byKey.entries()].find(([, row]) => row.stages.includes('triage'))?.[0]);
  const order = [
    ...split.order,
    ...split.groups.map((group) => group.index).filter((index) => !split.order.includes(index)),
  ];
  for (const index of order) {
    const group = split.groups.find((item) => item.index === index);
    if (!group) continue;
    const found = findRow(byKey, group.branch || group.title, group.chatId);
    if (found) {
      taken.add(found.key);
      ordered.push({
        ...found.row,
        title: group.title || found.row.title,
        ...(group.base ? { base: group.base } : {}),
      });
      continue;
    }
    ordered.push(pendingRow(group, split));
  }
  for (const [key] of byKey) take(key);
  return ordered;
}

/** Строка группы конвейера среди строк по чатам: по ключу ветки, иначе по чату. */
function findRow(
  byKey: Map<string, ChildStageGroup>,
  key: string,
  chatId: string | undefined,
): { key: string; row: ChildStageGroup } | undefined {
  const direct = byKey.get(key);
  if (direct) return { key, row: direct };
  if (!chatId) return undefined;
  for (const [known, row] of byKey) if (row.chatId === chatId) return { key: known, row };
  return undefined;
}

/** Строка группы, у которой чат уже есть. */
function groupRow(
  key: string,
  list: ChatSummary[],
  runs: ActiveRunView[],
): ChildStageGroup | undefined {
  const ordered = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const last = ordered.at(-1);
  if (!last) return undefined;

  return {
    chatId: last.id,
    // Имя группы приходит из связи (`groupTitle`): заголовок чата — это текст
    // его первого сообщения, а у детей одного разделения он начинается общей
    // преамбулой задания, и по нему группы неотличимы. Связи нет — падаем на
    // заголовок первого звена: он хотя бы принадлежит работе, а не её ревью.
    title: last.groupTitle || ordered[0]?.title || last.title || key,
    ...(last.branch ? { branch: last.branch } : {}),
    stages: ordered.map(stageOf),
    ...firstEditDelay(ordered.find((chat) => stageOf(chat) === 'work')),
    ...workTime(ordered),
    ...(last.model ? { model: last.model } : {}),
    // Ключ прогона сверяется дважды: разговор, заведённый панелью, живёт под
    // временным `new-…`, пока CLI не назовёт настоящий `sessionId`.
    isRunning: runs.some(
      (run) => (run.id === last.id || run.sessionId === last.id) && run.status === 'running',
    ),
  };
}

/**
 * Строка группы без чата: конвейер её ещё не завёл. Что именно она ждёт —
 * единственное, что тут можно показать, и единственное, что человеку нужно:
 * «ждёт ответа» — это про него.
 */
function pendingRow(group: SplitPlanView['groups'][number], split: SplitPlanView): ChildStageGroup {
  const titleOf = (index: number): string =>
    split.groups.find((item) => item.index === index)?.title ?? `#${index + 1}`;
  // Ждущее состояние конвейера — как есть; всё остальное («pending», а также
  // «started»/«done» у группы, чей чат до списка ещё не доехал) читается как
  // «ждёт итога разбора»: строке нужно сказать, почему группы не видно.
  const known = ['held', 'waiting', 'failed'] as const;
  const pending: ChildStageGroup['pending'] =
    known.find((status) => status === group.status) ?? 'pending';
  return {
    chatId: '',
    title: group.title,
    ...(group.branch ? { branch: group.branch } : {}),
    stages: [],
    isRunning: false,
    pending,
    ...(group.after.length > 0 ? { waitsFor: group.after.map(titleOf) } : {}),
    ...(group.hold ? { hold: { index: group.index, question: group.hold } } : {}),
    ...(group.holdAnswer ? { holdAnswered: true } : {}),
    ...(group.base ? { base: group.base } : {}),
    ...(group.error ? { error: group.error } : {}),
  };
}

/** Стадия связи; пусто или незнакомое читается как «работа» — так выглядят чаты до конвейера. */
function stageOf(chat: ChatSummary): CascadeStage {
  return (CASCADE_STAGES as readonly string[]).includes(chat.stage ?? '')
    ? (chat.stage as CascadeStage)
    : 'work';
}

/**
 * Сколько агент шёл до первой правки кода — по звену РАБОТЫ: план ничего не
 * правит, а ревью и правки стартуют в уже обжитой копии, и у них эта цифра ни
 * о чём. Момента нет (правок не было или чат старше метрики) — поля нет, не «0».
 */
function firstEditDelay(work: ChatSummary | undefined): { firstEditAfterMs?: number } {
  if (!work?.firstEditAt) return {};
  const delay = Date.parse(work.firstEditAt) - Date.parse(work.createdAt);
  return Number.isFinite(delay) && delay >= 0 ? { firstEditAfterMs: delay } : {};
}

/**
 * Сколько группа проработала — сумма по звеньям от заведения разговора до его
 * последней записи. Паузы между звеньями (ревью ждало человека) в сумму не
 * входят: это время человека, а не агента. Звено без дат сумму не портит, а
 * пропускается; нет ни одного измеримого — поля нет, не «0».
 */
function workTime(chain: ChatSummary[]): { workMs?: number } {
  let total = 0;
  let measured = false;
  for (const chat of chain) {
    const span = Date.parse(chat.updatedAt) - Date.parse(chat.createdAt);
    if (!Number.isFinite(span) || span < 0) continue;
    total += span;
    measured = true;
  }
  return measured ? { workMs: total } : {};
}
