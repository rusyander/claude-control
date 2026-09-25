import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatSummary, ChatMessage, ChatMessagesPage } from '@agentdeck/contracts';
import { isSandboxPath } from './ChatArtifacts.ts';
import { layoutForCwd } from '../project-git/copy-readiness.ts';
import {
  FULL_READ_LIMIT,
  fileSessionId,
  findTranscript,
  readHeadRecords,
  readRecords,
  streamLines,
} from './ChatTranscriptFile.ts';
import {
  branchOf,
  chatTitleText,
  countDialogMessages,
  firstMeaningfulText,
  firstValue,
  humanText,
  isAwaitingReply,
  isDialogMessage,
  isSyntheticReply,
  lastValue,
  opensWithPanel,
  toBlocks,
  toUsage,
  withAwaitingWindow,
  type ContentBlock,
  type Record,
} from './ChatRecords.ts';

/**
 * Чтение истории разговоров Claude Code из ~/.claude/projects.
 *
 * Транскрипт — это JSON Lines, куда строки только дописываются. Файлы бывают
 * очень большими (медиана около двух мегабайт, отдельные — за сотню), поэтому
 * читать их целиком ради строки в списке нельзя: для списка берём начало и
 * конец файла (`ChatTranscriptFile`), а разобранное держим в кеше по времени
 * изменения. Толкование записей живёт в `ChatRecords`.
 */

/** Сколько последних сообщений отдавать в ленту чата. */
const MESSAGE_LIMIT = 400;

/**
 * Сколько символов закрывающего хода отдавать наружу. Ход — одно сообщение, а
 * не весь разговор, и отдаётся он ЦЕЛИКОМ: реестр читает его именно тогда, когда
 * хвост потока (`TEXT_TAIL`) ответа не вместил, а блок бывает и в начале
 * (находка 24: 49 661 символ, блок разбора на 1 816-м). Потолок — только от
 * ответа неправдоподобного размера: читается это раз на конец прогона.
 */
const CLOSING_TURN_MAX = 512 * 1024;

export { findTranscript };

interface CacheEntry {
  mtimeMs: number;
  size: number;
  summary: ChatSummary;
}

const cache = new Map<string, CacheEntry>();

/**
 * Список чатов. Разговоры лежат в подкаталогах по проектам; вложенные папки
 * с ветками субагентов пропускаем — в списке нужны только сами сессии.
 */
export function readChats(projectsDir: string): ChatSummary[] {
  if (!existsSync(projectsDir)) return [];

  const chats: ChatSummary[] = [];

  for (const projectEntry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;

    const projectDir = join(projectsDir, projectEntry.name);
    for (const fileEntry of readdirSync(projectDir, { withFileTypes: true })) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) continue;

      const summary = readSummary(join(projectDir, fileEntry.name), projectEntry.name);
      if (summary) chats.push(summary);
    }
  }

  return chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function readSummary(path: string, projectName: string): ChatSummary | undefined {
  const stats = statSync(path);

  const cached = cache.get(path);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    // Окно ожидания считаем ПОСЛЕ кеша: сводка кешируется по времени файла и не
    // пересчитывается, а сутки идут — иначе вопрос оставался бы «свежим» вечно.
    return withAwaitingWindow(cached.summary, stats.mtimeMs);
  }

  const records = readRecords(path, stats.size);
  if (records.length === 0) return undefined;

  // Заголовок Claude Code генерирует сам и дописывает несколько раз —
  // верным считается последний.
  const title = lastValue(records, (record) =>
    record.type === 'ai-title' ? record.aiTitle : undefined,
  );
  const lastMessage = [...records].reverse().find(isDialogMessage);
  // Проект — ПЕРВЫЙ `cwd` транскрипта: там сессия начата и там её файл. Поздние
  // строки несут каталог оболочки агента: после `cd sub/dir` чат «уезжал» в
  // подпапку, а продолжение из неё заводило новую папку проекта у CLI.
  const projectPath = firstValue(records, (record) => record.cwd) ?? '';
  const ownTitle = title?.trim() || chatTitleText(records).slice(0, 70);

  const summary: ChatSummary = {
    id: fileSessionId(path),
    title: ownTitle || projectName,
    // Своих слов нет — имя проекта лишь заглушка; список поставит имя группы.
    // Так же и слова после реплики панели: у звена это ответ, а не задача.
    ...(ownTitle && (title?.trim() || !opensWithPanel(records)) ? {} : { untitled: true }),
    project: projectName,
    projectPath,
    isSandbox: Boolean(projectPath) && isSandboxPath(projectPath),
    // Разговор в git-копии числится и за основной копией — по файлу `.git`
    // копии, без запуска git: список перечитывается на каждое событие.
    homeProjectPath: projectPath ? layoutForCwd(projectPath).mainDir : undefined,
    messageCount: countDialogMessages(records),
    // Большой файл прочитан началом и хвостом (см. readRecords) — значит
    // середина не сосчитана. Отдаём это признаком, а не выдаём частичное число
    // за итог: в списке оно рисуется как «38+».
    messageCountPartial: stats.size > FULL_READ_LIMIT ? true : undefined,
    createdAt: records[0]?.timestamp ?? stats.birthtime.toISOString(),
    updatedAt: stats.mtime.toISOString(),
    preview: (lastMessage ? humanText(lastMessage) : '').slice(0, 160) || undefined,
    model: lastValue(records, (record) => record.message?.model),
    awaitingReply: isAwaitingReply(records) || undefined,
    // Ветка последней записи, а не первой: разговор мог начаться в main и
    // уехать в свою ветку, и в списке нужна та, где агент СЕЙЧАС.
    branch: lastValue(records, branchOf),
  };

  cache.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, summary });
  return withAwaitingWindow(summary, stats.mtimeMs);
}

/** Параметры окна ленты: сколько сообщений отдать и сколько новых пропустить. */
export interface MessagesWindow {
  /** Размер окна — сколько реплик вернуть. */
  limit?: number;
  /** Сколько самых свежих реплик пропустить (0 — отдаём хвост ленты). */
  offset?: number;
  /**
   * Id сообщений модели (`message.id` транскрипта), перед которыми контур сжал
   * историю. Реплика с таким id получает `contextSummarized`. Сам журнал сжатий
   * читает маршрут: лента о контурах не знает ничего, кроме этого набора.
   */
  summarizedIds?: ReadonlySet<string>;
}

/**
 * Переписка одного чата окном. Здесь, в отличие от списка, нужен полный проход
 * по файлу — иначе выпадут реплики из середины. Файл читается построчно, а в
 * памяти держится только нужное окно: транскрипт бывает стомегабайтным, и
 * тащить его в память целиком незачем.
 *
 * По умолчанию отдаётся хвост ленты (последние `limit` реплик). Более ранние
 * подгружаются увеличением `limit` («Загрузить ещё») либо сдвигом `offset` —
 * оба варианта окном, без чтения всего транскрипта в ответ.
 */
export async function readChatMessages(
  projectsDir: string,
  chatId: string,
  window: MessagesWindow = {},
): Promise<ChatMessagesPage> {
  const path = findTranscript(projectsDir, chatId);
  if (!path) return { messages: [], total: 0, hasMore: false };

  const limit = Math.max(1, Math.floor(window.limit ?? MESSAGE_LIMIT));
  const offset = Math.max(0, Math.floor(window.offset ?? 0));
  // Держим только последние (offset + limit) реплик: этого хватает, чтобы
  // вырезать нужное окно, а память не растёт с длиной транскрипта.
  const cap = offset + limit;

  const ring: ChatMessage[] = [];
  let total = 0;
  // Ход модели — несколько строк с одним `message.id`, по одной на блок
  // содержимого (см. countDialogMessages). В ленте это ОДНА реплика: иначе
  // размышление, вызов и текст одного хода шли тремя сообщениями, и у каждого
  // стоял свой бейдж с тем же самым расходом — в разы больше, чем потрачено.
  // Расход берём из последней строки хода: все они несут одинаковый.
  let tailId: string | undefined;

  for await (const line of streamLines(path)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;

    let record: Record;
    try {
      record = JSON.parse(trimmed) as Record;
    } catch {
      continue;
    }

    if (!isDialogMessage(record)) continue;

    const blocks = toBlocks(record);
    if (blocks.length === 0) continue;

    const messageId = record.type === 'assistant' ? record.message?.id : undefined;
    const tail = ring.at(-1);
    if (messageId && tail && tailId === messageId) {
      ring[ring.length - 1] = {
        ...tail,
        blocks: [...tail.blocks, ...blocks],
        usage: toUsage(record) ?? tail.usage,
      };
      continue;
    }
    const summarized = Boolean(messageId && window.summarizedIds?.has(messageId));

    tailId = messageId;
    total += 1;
    ring.push({
      id: record.uuid ?? String(total - 1),
      role: record.type === 'user' ? 'user' : 'assistant',
      blocks,
      timestamp: record.timestamp ?? '',
      parentId: record.parentUuid ?? undefined,
      usage: toUsage(record),
      gitBranch: branchOf(record),
      ...(summarized ? { contextSummarized: true } : {}),
    });

    // Лишнее с начала выбрасываем сразу, не дожидаясь конца файла.
    if (ring.length > cap) ring.shift();
  }

  // Окно [start, endExcl) в абсолютных индексах ленты; `endExcl` отступает от
  // конца на offset, `start` — ещё на limit назад.
  const endExcl = Math.max(0, total - offset);
  const start = Math.max(0, endExcl - limit);
  const ringStart = total - ring.length;
  const messages = ring.slice(start - ringStart, endExcl - ringStart);

  return { messages, total, hasMore: start > 0 };
}

/**
 * Исходное задание разговора — первая осмысленная реплика человека.
 *
 * Читается ТОЛЬКО начало файла: задание лежит в его первых строках, и размер
 * транскрипта на цену ответа не влияет. Поэтому спрашивают задание поштучно, у
 * выбранного разговора, а не строят его для всего списка: в списке оно никому
 * не нужно, а файлов там сотни.
 *
 * Разговора нет или начало без реплик человека — пустая строка: задание, которое
 * не прочитано, и задание, которого не было, для переноса одно и то же.
 */
export function readChatTask(projectsDir: string, chatId: string): string {
  const path = findTranscript(projectsDir, chatId);
  if (!path) return '';

  return firstMeaningfulText(readHeadRecords(path));
}

/**
 * Рабочая папка, из которой велась сессия.
 *
 * Claude Code привязывает сессию к каталогу: транскрипты разложены по папкам
 * вида `~/.claude/projects/<путь-с-заменёнными-разделителями>/`, и `--resume`
 * ищет сессию только среди сессий текущего каталога. Поэтому продолжать
 * разговор можно лишь оттуда, где он начинался, — этот путь и берём из самого
 * транскрипта. Берём ПЕРВЫЙ `cwd`: он записан в каждой строке, но поздние строки
 * несут каталог оболочки агента, и после `cd sub/dir` последний `cwd` уводил
 * продолжение в подпапку — CLI не находил там сессию и заводил новую.
 */
export function findSessionCwd(projectsDir: string, sessionId: string): string | undefined {
  const path = findTranscript(projectsDir, sessionId);
  if (!path) return undefined;

  // Начала хватает: первая строка с `cwd` лежит в первых строках файла, а читать
  // ради неё весь транскрипт (до четырёх мегабайт на каждую отправку) незачем.
  // В начале пусто — тогда уже тем же способом, что и список.
  const fromHead = firstValue(readHeadRecords(path), (record) => record.cwd);
  if (fromHead) return fromHead;

  const records = readRecords(path, statSync(path).size);
  return firstValue(records, (record) => record.cwd);
}

/**
 * Разобранный транскрипт для соседних разборщиков (прогресс агента). Читает тем
 * же способом, что и лента: маленький файл целиком, у большого — начало и хвост.
 */
export function readTranscriptRecords(path: string): TranscriptRecord[] {
  return readRecords(path, 0);
}

/**
 * Последний ЗАВЕРШЁННЫЙ ход агента из транскрипта — текст ответа, которым он
 * закончил разговор.
 *
 * Нужен усыновлённому прогону: после перезапуска панели поток вывода к живому
 * CLI не восстановить, а ответ никуда не делся — он в файле Claude Code. По
 * этому тексту решаются продолжение в чистой сессии, разбор уровня 1, план
 * группы и ревью по ссылке, и без него панель выбрасывала всё разом.
 *
 * «Завершённый» здесь строгое: последняя запись транскрипта должна быть ходом
 * АГЕНТА и в нём не должно быть вызова инструмента. Вызов без ответа значит,
 * что процесс оборвали на полуслове, а запись человека (в том числе результат
 * инструмента) после хода — что ход был серединой работы, а не её концом.
 * Ветки субагентов (`isSidechain`) пропускаем: там свой разговор.
 *
 * `asked` — ход с последней реплики человека звал `AskUserQuestion`. Потока у
 * усыновлённого прогона нет, и признак, который живому ставит событие потока,
 * берётся отсюда: отказ панели велит агенту «скажи, что ждёшь ответа», и
 * закрывающий ход — обычный текст (живой прогон 24.09: группа ушла в ревью,
 * пока вопрос висел). Реплика человека признак снимает — на тот вопрос уже
 * ответили.
 */
export function readLastAssistantTurn(
  projectsDir: string,
  chatId: string,
  cap = CLOSING_TURN_MAX,
): ClosingTurn | undefined {
  const path = findTranscript(projectsDir, chatId);
  if (!path) return undefined;

  let turnId: string | undefined;
  let parts: string[] = [];
  let calledTool = false;
  let asked = false;
  // Последняя осмысленная запись — ход агента. Пока false, накопленное не в счёт.
  let closing = false;

  for (const record of readRecords(path, 0)) {
    if (record.isSidechain || record.isMeta || record.isCompactSummary) continue;
    if (!record.message) continue;
    if (record.type !== 'assistant' && record.type !== 'user') continue;
    // Заглушку CLI модель не писала (журнал 96): концом хода она не бывает.
    if (isSyntheticReply(record)) continue;
    if (record.type === 'user' || record.isApiErrorMessage) {
      closing = false;
      if (record.type === 'user' && isHumanPrompt(record.message.content)) asked = false;
      continue;
    }

    const messageId = record.message.id;
    // Ход агента лежит НЕСКОЛЬКИМИ строками с одним `message.id` (см.
    // `countDialogMessages`) — склеиваем их, а на новом id начинаем заново.
    if (!closing || messageId !== turnId) {
      turnId = messageId;
      parts = [];
      calledTool = false;
    }
    const content = record.message.content;
    if (typeof content === 'string') {
      if (content.trim()) parts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text?.trim()) parts.push(block.text);
        else if (block.type === 'tool_use') {
          calledTool = true;
          if (block.name === 'AskUserQuestion') asked = true;
        }
      }
    }
    closing = true;
  }

  if (!closing || calledTool) return undefined;
  // Хвостом, как копит текст реестр прогонов: разборщикам нужен конец ответа.
  const text = parts.join('\n').trim().slice(-cap);
  return text ? { text, ...(asked ? { asked: true } : {}) } : undefined;
}

/** Закрывающий ход усыновлённого прогона: текст и вопрос инструментом. */
export interface ClosingTurn {
  text: string;
  asked?: boolean;
}

/**
 * Запись человека, а не результат инструмента: строка или блоки, среди которых
 * есть не только `tool_result`.
 */
function isHumanPrompt(content: string | ContentBlock[] | undefined): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  return Array.isArray(content) && content.some((block) => block.type !== 'tool_result');
}

export type TranscriptRecord = Record;
export type TranscriptBlock = ContentBlock;
