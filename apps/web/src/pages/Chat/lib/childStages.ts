import type { ChatSummary } from '@agentdeck/contracts';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
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

  const children = chats.filter((chat) => chat.parentId === parentChatId);
  if (children.length === 0 && !split) return [];

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
  if (!split) return [...byKey.values()];
  // Порядок старта и группы без чата — общее с лентой чужого CLI: тот же счёт
  // по той же записи конвейера, разный только источник готовых строк.
  return mergeSplitGroups(byKey, split);
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
