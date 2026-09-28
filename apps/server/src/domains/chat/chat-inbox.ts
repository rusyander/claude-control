import { existsSync, statSync } from 'node:fs';
import type { ChatSummary } from '@agentdeck/contracts';
import type {
  ChatInbox,
  InboxAsk,
  InboxChat,
  InboxQuestion,
} from '@agentdeck/contracts/chat-inbox';
import type { PendingPermissionInfo } from './ChatPermissions.ts';
import type { Record } from './ChatRecords.ts';
import { findTranscript, readTailRecords } from './ChatTranscriptFile.ts';
import { autoPickResults } from './auto-pick.ts';
import { layoutForCwd } from '../project-git/copy-readiness.ts';

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
 *   терминале (результат без ошибки) или автовыбор автономного чата.
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
/** Хвост транскрипта для поиска вопроса: вопрос — в последнем ходе. */
const ASK_TAIL_BYTES = 128 * 1024;

/** Прогон из реестра — ровно то, что сводке нужно. */
export interface InboxRun {
  key: string;
  sessionId?: string;
  projectPath?: string;
  cwd?: string;
  startedAt: number;
  prompt?: string;
}

/** Последний неотвеченный вызов `AskUserQuestion`. */
export interface AskedCall {
  toolUseId?: string;
  input: unknown;
  askedAt: string;
}

export interface InboxSources {
  chats: readonly ChatSummary[];
  /** Только идущие прогоны. */
  runs: readonly InboxRun[];
  permissions: readonly PendingPermissionInfo[];
  lastAsked: (chatId: string) => AskedCall | undefined;
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

  for (const draft of drafts.values()) {
    if (!draft.sessionId) continue;
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

/**
 * Последний неотвеченный вопрос в записях транскрипта.
 *
 * Ответом считается: реплика человека после вопроса; результат вызова БЕЗ
 * ошибки (выбор в терминале); автовыбор автономного чата (метка в отказе).
 * Отказ брокера панели ответом не считается — он и говорит агенту, что ответ
 * придёт следующим сообщением.
 */
export function lastAskedIn(records: readonly Record[]): AskedCall | undefined {
  let asked: AskedCall | undefined;
  for (const record of records) {
    if (record.isSidechain) continue;
    const content = record.message?.content;
    if (record.type === 'user' && !record.isMeta) {
      if (isHumanPrompt(content)) asked = undefined;
      else if (asked?.toolUseId && closes(content, asked.toolUseId)) asked = undefined;
      continue;
    }
    if (record.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== 'tool_use' || block.name !== 'AskUserQuestion') continue;
      asked = {
        ...(block.id ? { toolUseId: block.id } : {}),
        input: block.input,
        askedAt: record.timestamp ?? new Date(0).toISOString(),
      };
    }
  }
  return asked;
}

function closes(content: unknown, toolUseId: string): boolean {
  if (!Array.isArray(content)) return false;
  if (autoPickResults(content).some((pick) => pick.toolUseId === toolUseId)) return true;
  return (content as { type?: string; tool_use_id?: string; is_error?: boolean }[]).some(
    (block) =>
      block?.type === 'tool_result' && block.tool_use_id === toolUseId && block.is_error !== true,
  );
}

/**
 * Реплика, которую CLI пишет от имени человека сам: итог фоновой задачи
 * (команды или субагента). Приходит посреди хода, пока вопрос агента висит, —
 * ответом она не является (живой прогон 28.09: вопрос пропадал с телефона, как
 * только субагент хода отчитывался). Признак тот же, что у ленты панели
 * (`taskNoticesOf`): текст НАЧИНАЕТСЯ с тега.
 */
const CLI_NOTICE = /^\s*<task-notification>/;

function isHumanPrompt(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0 && !CLI_NOTICE.test(content);
  return (
    Array.isArray(content) &&
    content.some(
      (block: { type?: string; text?: unknown }) =>
        block.type !== 'tool_result' &&
        !(block.type === 'text' && typeof block.text === 'string' && CLI_NOTICE.test(block.text)),
    )
  );
}

/**
 * Читатель вопросов с памятью по файлу: телефон спрашивает сводку каждые
 * несколько секунд, а меняются за это время один-два транскрипта. Хвост
 * перечитывается, только когда у файла сменились время или размер.
 */
/** Сколько транскриптов помнит читатель вопросов. */
export const ASKED_CACHE_MAX = 500;

export function createLastAskedReader(
  projectsDir: () => string,
): (chatId: string) => AskedCall | undefined {
  const cache = new Map<
    string,
    { path: string; mtimeMs: number; size: number; value: AskedCall | undefined }
  >();
  return (chatId) => {
    const known = cache.get(chatId);
    const path =
      known && existsSync(known.path) ? known.path : findTranscript(projectsDir(), chatId);
    if (!path) return undefined;
    try {
      const stats = statSync(path);
      if (
        known &&
        known.path === path &&
        known.mtimeMs === stats.mtimeMs &&
        known.size === stats.size
      ) {
        // Вытеснение — по давности ОБРАЩЕНИЯ: Map помнит порядок вставки, и
        // запись, которую телефон спрашивает каждые секунды, уходила первой.
        cache.delete(chatId);
        cache.set(chatId, known);
        return known.value;
      }
      const value = lastAskedIn(readTailRecords(path, ASK_TAIL_BYTES));
      cache.delete(chatId);
      cache.set(chatId, { path, mtimeMs: stats.mtimeMs, size: stats.size, value });
      if (cache.size > ASKED_CACHE_MAX) cache.delete(cache.keys().next().value as string);
      return value;
    } catch {
      return undefined;
    }
  };
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
