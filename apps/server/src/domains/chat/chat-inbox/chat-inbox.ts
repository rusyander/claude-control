import type { ChatSummary } from '@agentdeck/contracts';
import type {
  ChatInbox,
  InboxAsk,
  InboxChat,
  InboxQuestion,
} from '@agentdeck/contracts/chat-inbox';
import type { PendingPermissionInfo } from '../ChatPermissions/ChatPermissions.ts';
import { layoutForCwd } from '../../project-git/copy-readiness.ts';
import type { AskedCall } from './transcript-tail.ts';

// Разбор хвоста транскрипта живёт рядом; прежний путь импорта остаётся рабочим.
export {
  ASKED_CACHE_MAX,
  OUTSIDE_LIVE_MS,
  createTranscriptTailReader,
  isHumanPrompt,
  lastAskedIn,
  liveByTail,
  turnOpenIn,
  type AskedCall,
  type TranscriptTail,
} from './transcript-tail.ts';

/**
 * Сводка ожиданий и активности по всем разговорам машины — для главного экрана
 * телефона (`GET /api/chat/inbox`).
 *
 * Три источника, и у каждого своя правда:
 *
 * - реестр прогонов — что идёт прямо сейчас (в том числе ещё без транскрипта:
 *   первый ход нового чата под ключом `new-…`);
 * - брокер прав — висящие запросы. Только тех прогонов, что живы: запрос
 *   умершего процесса ответить уже нельзя, и карточка с ним лгала бы;
 * - транскрипт — вопрос `AskUserQuestion`, на который никто не ответил. Панель
 *   в `-p` отвечает на него отказом «ответ придёт следующим сообщением», поэтому
 *   сам результат вызова ответом не считается; ответ — реплика человека, выбор в
 *   терминале (результат без ошибки) или автовыбор автономного чата. Только
 *   сессии, которую никто не сменил: разговор, продолженный под тем же ключом
 *   НОВОЙ сессией (остывшая группа после перезапуска), вопросов прежней уже не
 *   ждёт — ответ ушёл бы по ключу в разговор, который их не задавал.
 *
 * Слой не знает ни реестра, ни хранилища: данные ему приносит маршрут.
 */

/**
 * Окно «недавнего»: разговор, молчащий дольше суток, — не активный, а
 * прошлый; вопрос старше суток — брошенный. Та же граница, что у жёлтой точки в
 * списке чатов (`ChatRecords.ts`): иначе телефон и панель расходились бы в
 * ответе на вопрос «ждут ли меня».
 */
export const INBOX_RECENT_MS = 24 * 60 * 60 * 1000;
/** Сколько разговоров отдавать: ждущие и идущие — все, молчащие — до предела. */
export const INBOX_LIMIT = 40;

/** Прогон из реестра — ровно то, что сводке нужно. */
export interface InboxRun {
  key: string;
  sessionId?: string;
  projectPath?: string;
  cwd?: string;
  startedAt: number;
  prompt?: string;
}

/** Запрос прав сессии вне панели — ключом служит сессия, а не прогон. */
export interface OutsidePermission {
  toolUseId: string;
  sessionId: string;
  toolName: string;
  input?: unknown;
  askedAt: string;
}

export interface InboxSources {
  chats: readonly ChatSummary[];
  /** Только идущие прогоны. */
  runs: readonly InboxRun[];
  permissions: readonly PendingPermissionInfo[];
  /**
   * Запросы прав сессий вне панели, которые держит хук панели: окно на
   * компьютере показывает их же, решить можно и с телефона.
   */
  outsidePermissions?: readonly OutsidePermission[];
  lastAsked: (chatId: string) => AskedCall | undefined;
  /**
   * Сессию сменил новый разговор под тем же ключом (синоним ключа в хранилище
   * панели смотрит на другую сессию). Её неотвеченный вопрос — уже ничей.
   */
  replaced?: (sessionId: string) => boolean;
  /** Идёт ли ход вне панели (терминал, VS Code) — по хвосту транскрипта. */
  liveOutside?: (chatId: string) => boolean;
  /** Имя группы разделения для чата без своего названия. */
  groupTitle?: (chatId: string) => string | undefined;
  now: number;
}

interface Draft extends Omit<InboxChat, 'status'> {
  summary?: ChatSummary;
}

export function buildInbox(sources: InboxSources): ChatInbox {
  const since = sources.now - INBOX_RECENT_MS;
  const byId = new Map<string, ChatSummary>(sources.chats.map((chat) => [chat.id, chat]));
  const drafts = new Map<string, Draft>();

  const fromSummary = (chat: ChatSummary): Draft => ({
    id: chat.id,
    sessionId: chat.id,
    title: (chat.untitled && sources.groupTitle?.(chat.id)) || chat.title,
    // Имя папки, а не имя каталога транскрипта (`C--work-shop`): человек узнаёт
    // проект по папке. Чат в git-копии числится за основной копией.
    project: folderName(chat.homeProjectPath ?? chat.projectPath) || chat.project,
    projectPath: chat.projectPath,
    ...(chat.homeProjectPath && chat.homeProjectPath !== chat.projectPath
      ? { homeProjectPath: chat.homeProjectPath }
      : {}),
    isSandbox: chat.isSandbox,
    running: false,
    updatedAt: chat.updatedAt,
    ...(chat.preview ? { preview: chat.preview } : {}),
    asks: [],
    summary: chat,
  });

  for (const chat of sources.chats) {
    if (Date.parse(chat.updatedAt) >= since) drafts.set(chat.id, fromSummary(chat));
  }

  const byRun = new Map<string, Draft>();
  for (const run of sources.runs) {
    const id = run.sessionId ?? run.key;
    const known = drafts.get(id) ?? (byId.has(id) ? fromSummary(byId.get(id)!) : undefined);
    const path = run.projectPath ?? run.cwd ?? '';
    // Первый ход (`new-…`) сводки ещё не имеет: основную копию считаем по
    // каталогу прогона так же, как сводка (`ChatHistory`) — иначе живой чат в
    // git-копии попадал на телефоне в отдельную группу.
    const home = path ? layoutForCwd(path).mainDir : undefined;
    const draft: Draft = known ?? {
      id,
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      title: firstLine(run.prompt) || folderName(path),
      project: folderName(home ?? path),
      projectPath: path,
      ...(home && home !== path ? { homeProjectPath: home } : {}),
      isSandbox: false,
      running: false,
      updatedAt: new Date(run.startedAt).toISOString(),
      asks: [],
    };
    draft.running = true;
    draft.runKey = run.key;
    draft.updatedAt = latest(draft.updatedAt, new Date(run.startedAt).toISOString());
    drafts.set(id, draft);
    byRun.set(run.key, draft);
  }

  // Разговор из терминала или VS Code в реестре не числится: что он работает,
  // видно только по транскрипту. Без этого телефон показывал «молчит» ровно
  // тогда, когда агент на компьютере вовсю шёл по шагам.
  for (const draft of drafts.values()) {
    if (draft.running || !draft.sessionId || !sources.liveOutside?.(draft.sessionId)) continue;
    draft.running = true;
    draft.outside = true;
  }

  for (const permission of sources.permissions) {
    const draft = byRun.get(permission.runId);
    if (!draft) continue;
    const kind = permission.kind ?? 'permission';
    draft.asks.push({
      kind,
      key: `${kind === 'branchGate' ? 'g' : 'p'}:${permission.toolUseId}`,
      toolUseId: permission.toolUseId,
      toolName: permission.toolName,
      input: permission.input,
      askedAt: permission.askedAt,
    });
  }

  for (const permission of sources.outsidePermissions ?? []) {
    const summary = byId.get(permission.sessionId);
    const draft = drafts.get(permission.sessionId) ?? (summary ? fromSummary(summary) : undefined);
    if (!draft) continue;
    drafts.set(permission.sessionId, draft);
    draft.asks.push({
      kind: 'permission',
      key: `r:${permission.toolUseId}`,
      toolUseId: permission.toolUseId,
      toolName: permission.toolName,
      input: permission.input,
      askedAt: permission.askedAt,
      relay: true,
    });
  }

  for (const draft of drafts.values()) {
    if (!draft.sessionId || sources.replaced?.(draft.sessionId)) continue;
    const asked = sources.lastAsked(draft.sessionId);
    if (!asked || Date.parse(asked.askedAt) < since) continue;
    draft.asks.push(...questionAsks(asked));
  }

  const chats = [...drafts.values()].map(({ summary: _summary, ...draft }): InboxChat => {
    const asks = [...draft.asks].sort(byAskedAt);
    const newest = asks.reduce((at, ask) => latest(at, ask.askedAt), draft.updatedAt);
    return {
      ...draft,
      asks,
      updatedAt: newest,
      status: asks.length > 0 ? 'waiting' : draft.running ? 'running' : 'idle',
    };
  });
  chats.sort((a, b) => RANK[a.status] - RANK[b.status] || b.updatedAt.localeCompare(a.updatedAt));
  const busy = chats.filter((chat) => chat.status !== 'idle');
  const idle = chats.filter((chat) => chat.status === 'idle');
  return {
    generatedAt: new Date(sources.now).toISOString(),
    chats: [...busy, ...idle.slice(0, Math.max(0, INBOX_LIMIT - busy.length))],
  };
}

const RANK: { [key in InboxChat['status']]: number } = { waiting: 0, running: 1, idle: 2 };

function byAskedAt(a: InboxAsk, b: InboxAsk): number {
  return a.askedAt.localeCompare(b.askedAt) || a.key.localeCompare(b.key);
}

/** Строки вызова `AskUserQuestion` — по одной на вопрос, с общим числом. */
export function questionAsks(asked: AskedCall): InboxAsk[] {
  const questions = parseQuestions(asked.input);
  const id = asked.toolUseId ?? asked.askedAt;
  return questions.map((question, index) => ({
    kind: 'question' as const,
    key: `q:${id}:${index}`,
    ...(asked.toolUseId ? { toolUseId: asked.toolUseId } : {}),
    index,
    total: questions.length,
    question,
    askedAt: asked.askedAt,
  }));
}

/** Тело вызова пишет модель — берём только то, что похоже на вопрос. */
export function parseQuestions(input: unknown): InboxQuestion[] {
  const raw = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw)) return [];
  const out: InboxQuestion[] = [];
  for (const item of raw as { [key: string]: unknown }[]) {
    if (!item || typeof item.question !== 'string' || !item.question.trim()) continue;
    const options = Array.isArray(item.options)
      ? (item.options as { [key: string]: unknown }[])
          .filter((option) => option && typeof option.label === 'string' && option.label.trim())
          .map((option) => ({
            label: String(option.label),
            ...(typeof option.description === 'string' && option.description
              ? { description: option.description }
              : {}),
          }))
      : [];
    out.push({
      question: item.question,
      ...(typeof item.header === 'string' && item.header ? { header: item.header } : {}),
      ...(item.multiSelect === true ? { multiSelect: true } : {}),
      options,
    });
  }
  return out;
}

function latest(a: string, b: string): string {
  return a.localeCompare(b) >= 0 ? a : b;
}

function firstLine(text: string | undefined): string {
  const line = (text ?? '').trim().split(/\r?\n/)[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
