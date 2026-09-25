import type { ChatSummary } from '@agentdeck/contracts';
import type { ChatTreeView, SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { CASCADE_STAGES, type CascadeStage } from '@agentdeck/contracts/model-cascade';
import type { ActiveRunView } from '@shared/lib/agent-runs';
import { mergeSplitGroups, splitGroupKey, type ChildStageGroup } from '@features/ChatMessages';

/**
 * Сводка «кто на чём работает» для родительского разговора.
 *
 * Разделение развело работу по группам, а конвейер подбора модели добавил
 * каждой группе до четырёх разговоров: план, работа, её проверка на потолке,
 * правки по замечаниям — плюс один разбор на всё разделение. В списке чатов
 * это полтора десятка строк на три группы, и по ним не прочесть главного — на
 * каком звене группа стоит СЕЙЧАС и чем оно ведётся.
 *
 * Поэтому сводка считается по ГРУППАМ, а не по чатам: звенья одной группы
 * держит вместе номер группы из связи (Д12), у связей старше него — ветка, а
 * без неё (делили не репозиторий) — имя группы, под которым её завело
 * разделение.
 *
 * Показывается ПОСЛЕДНЕЕ звено группы: оно и есть её нынешнее состояние, а
 * пройденные подписаны рядом, чтобы был виден путь. «Идёт» — если идёт любое
 * звено: правки работали, пока последним уже стоял чат отправки, и группа
 * выглядела стоящей. Порядок внутри группы — по
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

  // Чаты групп, отброшенных перезапуском разделения (L20), — отдельно: в
  // склейку с конвейером их пускать нельзя. Ветка у них та же, что у
  // перезапущенной группы, и группа в очереди «занимала» строку мёртвого чата.
  const kids = chats.filter((chat) => chat.parentId === parentChatId);
  const children = kids.filter((chat) => !chat.retired);
  const retired = kids.filter((chat) => chat.retired).map((chat) => retiredRow(chat, runs));
  if (children.length === 0 && !split) return retired;

  // Заголовок чата ключом не годится: это текст его первого сообщения, а он у
  // работы, её ревью и правок разный — три звена разъехались бы по трём строкам.
  const groups = new Map<string, ChatSummary[]>();
  for (const chat of children) {
    const key = splitGroupKey({ ...chat, title: chat.groupTitle });
    const list = groups.get(key);
    if (list) list.push(chat);
    else groups.set(key, [chat]);
  }

  const byKey = new Map<string, ChildStageGroup>();
  for (const [key, list] of groups) {
    const row = groupRow(key, list, runs);
    if (row) byKey.set(key, row);
  }
  if (!split) return [...byKey.values(), ...retired];
  // Порядок старта и группы без чата — общее с лентой чужого CLI: тот же счёт
  // по той же записи конвейера, разный только источник готовых строк.
  return [...mergeSplitGroups(byKey, split), ...retired];
}

/**
 * Дерево, каким его видит хаб ЭТОГО разговора. Сервер отдаёт дерево по корню,
 * и в чате группы приезжал план всего разделения: хаб звена рисовал все группы
 * «ждёт итога разбора» и кнопки «Остановить всё / Отменить план» чужого плана
 * (живой прогон 26.09, F2). План принадлежит разговору, который его завёл.
 */
export function treeForChat(
  tree: ChatTreeView | undefined,
  chatId: string | undefined,
): ChatTreeView | undefined {
  if (!tree?.split || tree.split.parentChatId === chatId) return tree;
  const own = { ...tree };
  delete own.split;
  return own;
}

/**
 * Решение «До MR» группы, принятое при разделении, — для шапки её чата. Путь
 * копии даёт настройку проекта, а она расходится с планом, запущенным с другим
 * выбором (живой прогон 25.09, O2). Не группа или план не её родителя — нет.
 */
export function groupDeliverOf(
  tree: ChatTreeView | undefined,
  chat: Pick<ChatSummary, 'parentId' | 'groupIndex'> | undefined,
): boolean | undefined {
  const split = tree?.split;
  if (!split || !chat?.parentId || chat.groupIndex === undefined) return undefined;
  if (split.parentChatId !== chat.parentId) return undefined;
  return split.groups.find((group) => group.index === chat.groupIndex)?.deliver;
}

/**
 * Строка отброшенного чата — по одной на разговор, без склейки в группу:
 * номера группы и её имени у такой связи сервер уже не отдаёт, а ветку агент
 * волен был сменить. Показывается под «Неактивно», открыть её можно.
 */
function retiredRow(chat: ChatSummary, runs: ActiveRunView[]): ChildStageGroup {
  return {
    chatId: chat.id,
    title: chat.title || chat.id,
    ...(chat.branch ? { branch: chat.branch } : {}),
    stages: [stageOf(chat)],
    isRunning: runs.some(
      (run) => (run.id === chat.id || run.sessionId === chat.id) && run.status === 'running',
    ),
    retired: true,
    ...(chat.copyLeft && chat.parentId ? { retiredCopy: { parentChatId: chat.parentId } } : {}),
  };
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
  const isRunning = ordered.some((chat) =>
    runs.some(
      (run) => (run.id === chat.id || run.sessionId === chat.id) && run.status === 'running',
    ),
  );

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
    ...chainSpan(ordered),
    ...(last.model ? { model: last.model } : {}),
    // Ключ прогона сверяется дважды: разговор, заведённый панелью, живёт под
    // временным `new-…`, пока CLI не назовёт настоящий `sessionId`.
    isRunning,
    // Звено спросило человека инструментом и стоит (Д16): из транскрипта, а не
    // из конвейера — вопрос бывает и у разговора, продолженного руками.
    ...(last.awaitingReply && !isRunning ? { waitingFor: 'question' as const } : {}),
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

/**
 * Начало цепочки и её последняя запись — моменты, а не длительность: сколько
 * ИДЁТ прогон, считается от начала до «сейчас», и последняя запись молчащего
 * разбора (L13) тут бы соврала. Цепочка упорядочена по заведению.
 */
function chainSpan(chain: ChatSummary[]): { startedAt?: string; lastAt?: string } {
  const startedAt = chain[0]?.createdAt;
  const lastAt = chain
    .map((chat) => chat.updatedAt)
    .filter((at) => Number.isFinite(Date.parse(at)))
    .sort()
    .at(-1);
  return {
    ...(startedAt && Number.isFinite(Date.parse(startedAt)) ? { startedAt } : {}),
    ...(lastAt ? { lastAt } : {}),
  };
}
