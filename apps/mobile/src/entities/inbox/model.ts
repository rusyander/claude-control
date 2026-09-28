import type { InboxAsk, InboxChat, InboxChatStatus } from '@agentdeck/contracts/chat-inbox';

/**
 * Главный экран телефона: что идёт и кто ждёт человека — по всем проектам.
 * Здесь только разбор ответа сервера (`GET /chat/inbox`), без React: его и
 * проверяют тесты.
 */

/** Ждущие наверх, за ними идущие, молчащие последними. */
export const STATUS_RANK: { [key in InboxChatStatus]: number } = {
  waiting: 0,
  running: 1,
  idle: 2,
};

export interface ProjectGroup {
  /** Ключ группы — путь основной копии, у песочницы свой. */
  key: string;
  name: string;
  path: string;
  isSandbox: boolean;
  chats: InboxChat[];
  waiting: number;
  running: number;
  /** Свежайшее движение в группе. */
  updatedAt: string;
}

export const SANDBOX_GROUP = 'sandbox';

/**
 * Чаты по проектам. Проект — основная копия: разговор в git-копии числится за
 * ней, иначе один проект распадался бы на столько групп, сколько у него копий.
 * Порядок внутри и между группами — по тому, кто важнее человеку сейчас: сперва
 * ждущие ответа, потом идущие, потом свежие по времени.
 */
export function projectGroups(
  chats: readonly InboxChat[],
  sent: ReadonlySet<string> = new Set(),
): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const raw of chats) {
    const chat = withoutSent(raw, sent);
    const path = chat.homeProjectPath ?? chat.projectPath;
    const key = chat.isSandbox ? SANDBOX_GROUP : groupPathKey(path) || chat.project;
    const group = groups.get(key) ?? {
      key,
      name: chat.project,
      path,
      isSandbox: chat.isSandbox,
      chats: [],
      waiting: 0,
      running: 0,
      updatedAt: chat.updatedAt,
    };
    group.chats.push(chat);
    // Одно состояние на чат: ждущий ответа и при этом работающий считается
    // ждущим, иначе один чат давал бы «ждут: 1 · работают: 1».
    if (chat.status === 'waiting') group.waiting += 1;
    else if (chat.status === 'running') group.running += 1;
    if (chat.updatedAt > group.updatedAt) group.updatedAt = chat.updatedAt;
    groups.set(key, group);
  }
  for (const group of groups.values()) group.chats.sort(byImportance);
  return [...groups.values()].sort(
    (a, b) =>
      rankOf(a) - rankOf(b) || b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key),
  );
}

/**
 * Ключ пути для группы. Регистр сводится только у путей Windows: на сервере
 * Linux `/srv/Repo` и `/srv/repo` — два проекта, и нижний регистр склеивал их
 * в одну группу с именем того, кто пришёл первым (F-151).
 */
function groupPathKey(path: string): string {
  const isWindows = /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\');
  const trimmed = path.replace(/[\\/]+$/, '');
  return isWindows ? trimmed.replace(/\\/g, '/').toLowerCase() : trimmed;
}

/**
 * Чат глазами телефона: отправленное отсюда уже не ждёт. Без этого вкладка
 * «Вопросы» пустела сразу после «Отправить», а строка чата ещё говорила «ждёт
 * ответа · 1 вопрос» — до следующего опроса сервера (F-153).
 */
function withoutSent(chat: InboxChat, sent: ReadonlySet<string>): InboxChat {
  const asks = visibleAsks(chat, sent);
  if (asks.length === chat.asks.length) return chat;
  const status = chat.status === 'waiting' && asks.length === 0 ? idleOrRunning(chat) : chat.status;
  return { ...chat, asks, status };
}

const idleOrRunning = (chat: InboxChat): InboxChatStatus => (chat.running ? 'running' : 'idle');

function rankOf(group: ProjectGroup): number {
  if (group.waiting > 0) return 0;
  if (group.running > 0) return 1;
  return 2;
}

export function byImportance(a: InboxChat, b: InboxChat): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    b.updatedAt.localeCompare(a.updatedAt) ||
    a.id.localeCompare(b.id)
  );
}

/** Ожидания чата, которые ещё не отправлены с этого телефона. */
export function visibleAsks(chat: InboxChat, sent: ReadonlySet<string>): InboxAsk[] {
  return chat.asks.filter((ask) => !sentKeys(chat, ask).some((key) => sent.has(key)));
}

type ChatNames = Pick<InboxChat, 'id' | 'runKey' | 'sessionId'>;

/**
 * Ключи отправленного ответа — с чатом: `toolUseId` уникален лишь внутри
 * разговора. Одного имени у чата нет: `id` — ключ прогона, пока нет сессии,
 * потом id сессии (F-190), а ключ прогона появляется с ходом и пропадает с его
 * концом — у вопроса из транскрипта и при ходе со стола (D2). Ответ помечается
 * под КАЖДЫМ именем, которое чат носит в момент отправки, и скрыт, пока чат
 * носит хоть одно из них: иначе отвеченная карточка возвращалась, и на неё
 * можно было ответить второй раз.
 */
export function sentKeys(chat: ChatNames, ask: Pick<InboxAsk, 'key'>): string[] {
  const names = new Set([chat.sessionId, chat.runKey, chat.id].filter(Boolean));
  return [...names].map((name) => `${name}\u0000${ask.key}`);
}

/**
 * Имя карточки для списка: сессия, пока она есть, — она не меняется ни с
 * началом хода со стола, ни с его концом, и начатый ответ не сбрасывается.
 * До сессии — ключ прогона: вопрос раньше первой записи CLI не задаёт.
 */
export function stableChatKey(chat: ChatNames): string {
  return chat.sessionId ?? chat.runKey ?? chat.id;
}

export interface QuestionCardData {
  chat: InboxChat;
  asks: InboxAsk[];
}

/**
 * Карточки вкладки «Вопросы»: по одной на чат. Порядок — кто ждёт дольше,
 * тот выше, и он НЕ меняется от прихода нового вопроса: новый чат встаёт
 * вниз, а не сдвигает карточку, на которую человек сейчас отвечает.
 */
export function questionCards(
  chats: readonly InboxChat[],
  sent: ReadonlySet<string>,
): QuestionCardData[] {
  return chats
    .map((chat) => ({ chat, asks: visibleAsks(chat, sent) }))
    .filter((card) => card.asks.length > 0)
    .sort(
      (a, b) =>
        (a.asks[0]?.askedAt ?? '').localeCompare(b.asks[0]?.askedAt ?? '') ||
        a.chat.id.localeCompare(b.chat.id),
    );
}

export interface AskKinds {
  questions: number;
  /** Разрешения на вызов и первая правка в основной копии — обе просят «можно?». */
  permissions: number;
}

/** Что именно ждёт в чате — значок называет это словами, а не одним «вопросом». */
export function askKinds(asks: readonly Pick<InboxAsk, 'kind'>[]): AskKinds {
  let questions = 0;
  for (const ask of asks) if (ask.kind === 'question') questions += 1;
  return { questions, permissions: asks.length - questions };
}

/** Сколько всего ждёт ответа — число на вкладке. */
export function pendingCount(chats: readonly InboxChat[], sent: ReadonlySet<string>): number {
  return chats.reduce((sum, chat) => sum + visibleAsks(chat, sent).length, 0);
}

/**
 * Ключи отправленного, которых сервер больше не отдаёт: ответ дошёл, память о
 * нём не нужна. Пока сервер ещё отдаёт тот же вопрос (опрос не успел), ключ
 * держит карточку скрытой — иначе она мигнула бы обратно.
 */
export function staleSent(chats: readonly InboxChat[], sent: ReadonlySet<string>): string[] {
  const live = new Set(chats.flatMap((chat) => chat.asks.flatMap((ask) => sentKeys(chat, ask))));
  return [...sent].filter((key) => !live.has(key));
}

/** «5 мин», «2 ч», «3 дн» — без календаря: важна свежесть, а не дата. */
export function ageMinutes(iso: string, now: number): number {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.floor((now - at) / 60_000));
}

/**
 * Одна строка о том, ЧТО собирается сделать инструмент: команда, файл, адрес.
 * Полный вход остаётся под «Подробнее» — решение принимают по сути вызова, и
 * прятать её за JSON значило бы разрешать вслепую.
 */
export function toolSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const fields = input as { [key: string]: unknown };
  for (const name of ['command', 'file_path', 'notebook_path', 'url', 'path', 'pattern', 'query']) {
    const value = fields[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}
