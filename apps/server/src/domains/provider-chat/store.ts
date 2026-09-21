import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  ProviderChatDetail,
  ProviderChatMessage,
  ProviderChatSummary,
} from '@agentdeck/contracts';

/**
 * Переписка чужого провайдера на диске: один файл JSONL на разговор, рядом с
 * состоянием панели (`<appData>/provider-chats/<провайдер>/<id>.jsonl`).
 *
 * Почему панель вообще что-то хранит сама — при том что её принцип «источник
 * правды это файлы CLI». У Claude переписку ведёт он сам, и панель её читает. У
 * остальных CLI такой истории либо нет, либо её формат не задокументирован —
 * значит, либо панель ведёт свою, либо у чужого провайдера не может быть ни
 * списка разговоров, ни продолжения вчерашнего, ни памяти между вопросами.
 * Формат простой и наш собственный: ничего чужого здесь не разбирается.
 *
 * Первая строка файла — запись `meta`, дальше по строке на реплику. Дописывание
 * реплики — это `append` одной строки: обрыв на середине портит ровно последнюю
 * строку, а не весь разговор, и чтение её просто пропустит.
 */

/**
 * Стадия конвейера «работа → ревью → правки» у чужого CLI.
 *
 * Живёт в шапке разговора, а не в `ChatLink` состояния панели, и это главное
 * решение здесь. Связи панели ключуются идентификаторами чатов Claude и держат
 * дерево, хаб и сводку звеньев; разговор чужого провайдера в них не значится
 * вовсе (см. `routes/chat/split-routes.ts`). Класть стадию туда значило бы
 * заводить записи о чатах, которых для той половины панели не существует, —
 * а здесь она лежит ровно там же, где `model`/`effort`, и переживает
 * перезапуск сервера тем же способом.
 */
export interface ProviderChatCascade {
  /**
   * Звено конвейера. `triage` и `plan` (Т3 партии чужих CLI) идут ПЕРЕД работой
   * и на «потолке» чужого CLI — то есть прогоном без флага модели: панель не
   * знает, чем настроен CLI, и умеет только понижать.
   */
  stage: 'triage' | 'plan' | 'work' | 'review' | 'fix';
  /** Название группы разделения: по нему называются все звенья цепочки. */
  group?: string;
  /** Класс работы, если подбор его распознал. */
  kind?: string;
  /** Работа поехала НИЖЕ настройки CLI — это и оплачивается ревью. */
  lowered?: boolean;
  /** Чем шла работа: на неё возвращаются правки. */
  workModel?: string;
  workEffort?: string;
  /** Ветка копии: её читает ревьюер и по ней же называются звенья. */
  branch?: string;
  /** Работу уже проверяли — второго ревью на неё не бывает. */
  reviewedAt?: string;
  /** По плану уже завели работу — второй раз по тому же плану её не заводят. */
  plannedAt?: string;
}

/** Запись файла: шапка разговора либо одна реплика. */
interface MetaRecord {
  kind: 'meta';
  id: string;
  providerId: string;
  title: string;
  createdAt: string;
  workdir?: string;
  /** Подбор модели под задачу (Т12): чем ведётся ЭТОТ разговор. */
  model?: string;
  effort?: string;
  /** Конвейер подбора модели (07.09.2026): какое это звено и чем его платить. */
  cascade?: ProviderChatCascade;
}

interface MessageRecord extends ProviderChatMessage {
  kind: 'message';
}

/**
 * Идентификатор разговора и провайдера уходят в путь файла, поэтому набор
 * символов узкий: буквы, цифры, дефис и подчёркивание. Точки нет намеренно —
 * с ней пришлось бы отдельно ловить `..`, а так вырваться из каталога нечем.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function isSafeId(value: string): boolean {
  return SAFE_ID.test(value);
}

function providerDir(appDataDir: string, providerId: string): string | undefined {
  return isSafeId(providerId) ? join(appDataDir, 'provider-chats', providerId) : undefined;
}

function chatFile(appDataDir: string, providerId: string, chatId: string): string | undefined {
  const dir = providerDir(appDataDir, providerId);
  return dir && isSafeId(chatId) ? join(dir, `${chatId}.jsonl`) : undefined;
}

/**
 * Путь транскрипта разговора — для тех, кто его не читает, а НАЗЫВАЕТ.
 *
 * Заведено надзирателем рантайма (П3.1): в нагрузке события `transcript_path`
 * показывает на этот файл, и скрипт хука вправе его открыть. Раскладкой владеет
 * этот модуль, поэтому путь отдаётся отсюда — второй копии `provider-chats/<id>`
 * в проекте быть не должно.
 *
 * `undefined` — идентификатор непригоден для пути (см. `SAFE_ID`), а не «файла
 * нет»: существование здесь не проверяется, разговор мог ещё не начаться.
 */
export function chatTranscriptPath(
  appDataDir: string,
  providerId: string,
  chatId: string,
): string | undefined {
  return chatFile(appDataDir, providerId, chatId);
}

/** Название по первому вопросу: список разговоров должен читаться без открытия. */
export function titleFromText(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  if (!line) return 'Без названия';
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

function readRecords(file: string): { meta?: MetaRecord; messages: ProviderChatMessage[] } {
  const messages: ProviderChatMessage[] = [];
  let meta: MetaRecord | undefined;

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const record = JSON.parse(text) as MetaRecord | MessageRecord;
      if (record.kind === 'meta') meta = record;
      else if (record.kind === 'message') {
        const { kind: _kind, ...message } = record;
        messages.push(message);
      }
    } catch {
      // Оборванная последняя строка (сервер сняли посреди записи) — пропускаем
      // её, а не теряем разговор целиком.
    }
  }

  return { meta, messages };
}

function toSummary(meta: MetaRecord, messages: ProviderChatMessage[]): ProviderChatSummary {
  return {
    id: meta.id,
    providerId: meta.providerId,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: messages.at(-1)?.at ?? meta.createdAt,
    messageCount: messages.length,
    ...(meta.workdir ? { workdir: meta.workdir } : {}),
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.effort ? { effort: meta.effort } : {}),
  };
}

/** Новый разговор. Идентификатор придумывается здесь же и уходит в имя файла. */
export function createChat(
  appDataDir: string,
  providerId: string,
  options: {
    title?: string;
    workdir?: string;
    now?: Date;
    id?: string;
    /** Подбор модели под задачу (Т12): назначение живёт в шапке разговора. */
    model?: string;
    effort?: string;
    /** Звено конвейера, если разговор заведён им, а не человеком. */
    cascade?: ProviderChatCascade;
  } = {},
): ProviderChatSummary | undefined {
  const dir = providerDir(appDataDir, providerId);
  if (!dir) return undefined;

  const id = options.id ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  if (!isSafeId(id)) return undefined;

  const meta: MetaRecord = {
    kind: 'meta',
    id,
    providerId,
    title: options.title?.trim() || 'Новый разговор',
    createdAt: (options.now ?? new Date()).toISOString(),
    ...(options.workdir ? { workdir: options.workdir } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.cascade ? { cascade: options.cascade } : {}),
  };

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify(meta)}\n`, 'utf8');

  return toSummary(meta, []);
}

/** Все разговоры провайдера, свежие сверху. */
export function listChats(appDataDir: string, providerId: string): ProviderChatSummary[] {
  const dir = providerDir(appDataDir, providerId);
  if (!dir || !existsSync(dir)) return [];

  const summaries: ProviderChatSummary[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      const { meta, messages } = readRecords(join(dir, name));
      if (meta) summaries.push(toSummary(meta, messages));
    } catch {
      // Нечитаемый файл не должен прятать остальные разговоры.
    }
  }

  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Разговор целиком: шапка и все реплики. */
export function readChat(
  appDataDir: string,
  providerId: string,
  chatId: string,
): ProviderChatDetail | undefined {
  const file = chatFile(appDataDir, providerId, chatId);
  if (!file || !existsSync(file)) return undefined;

  try {
    const { meta, messages } = readRecords(file);
    if (!meta) return undefined;
    return { ...toSummary(meta, messages), messages };
  } catch {
    return undefined;
  }
}

/** Дописать реплику. Возвращает её же — с проставленными id и временем. */
export function appendMessage(
  appDataDir: string,
  providerId: string,
  chatId: string,
  message: Omit<ProviderChatMessage, 'id' | 'at'> & { id?: string; at?: string },
): ProviderChatMessage | undefined {
  const file = chatFile(appDataDir, providerId, chatId);
  if (!file || !existsSync(file)) return undefined;

  const stored: ProviderChatMessage = {
    ...message,
    id: message.id ?? `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    at: message.at ?? new Date().toISOString(),
  };

  appendFileSync(file, `${JSON.stringify({ kind: 'message', ...stored })}\n`, 'utf8');

  // Первый вопрос даёт разговору название — но только если своего ещё нет.
  if (stored.role === 'user') {
    const { meta, messages } = readRecords(file);
    if (meta && meta.title === 'Новый разговор' && messages.length === 1) {
      writeMeta(file, { ...meta, title: titleFromText(stored.content) }, messages);
    }
  }

  return stored;
}

/**
 * Переписать шапку. Файл собирается заново и подменяется целиком: шапка — первая
 * строка, дописыванием её не поправить. Запись идёт во временный файл рядом и
 * переименованием на место, чтобы обрыв не оставил половину разговора.
 */
function writeMeta(file: string, meta: MetaRecord, messages: ProviderChatMessage[]): void {
  const lines = [
    JSON.stringify(meta),
    ...messages.map((message) => JSON.stringify({ kind: 'message', ...message })),
  ];
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${lines.join('\n')}\n`, 'utf8');
  renameSync(temp, file);
}

/** Переименовать разговор или сменить его рабочий каталог. */
export function patchChat(
  appDataDir: string,
  providerId: string,
  chatId: string,
  patch: { title?: string; workdir?: string },
): ProviderChatSummary | undefined {
  const file = chatFile(appDataDir, providerId, chatId);
  if (!file || !existsSync(file)) return undefined;

  const { meta, messages } = readRecords(file);
  if (!meta) return undefined;

  const title = patch.title?.trim();
  const next: MetaRecord = {
    ...meta,
    ...(title ? { title } : {}),
    // Пустая строка — осознанное «без каталога», поэтому отличается от «поле не прислали».
    ...(patch.workdir === undefined ? {} : patch.workdir ? { workdir: patch.workdir } : {}),
  };
  if (patch.workdir === '') delete next.workdir;

  writeMeta(file, next, messages);

  return toSummary(next, messages);
}

/**
 * Стадия конвейера у этого разговора. Отдельным чтением, а не полем в
 * `ProviderChatDetail`: стадия — служебная запись панели, человеку и вкладке она
 * не показывается, а в контракте разговора значилась бы полем, которое некому
 * читать.
 */
export function readChatCascade(
  appDataDir: string,
  providerId: string,
  chatId: string,
): ProviderChatCascade | undefined {
  const file = chatFile(appDataDir, providerId, chatId);
  if (!file || !existsSync(file)) return undefined;

  try {
    return readRecords(file).meta?.cascade;
  } catch {
    return undefined;
  }
}

/**
 * Дописать стадию — ею работа помечается проверенной. Файл переписывается
 * целиком (шапка — первая строка), поэтому вызывать это на каждую реплику
 * нельзя: отметка ставится один раз за звено.
 */
export function setChatCascade(
  appDataDir: string,
  providerId: string,
  chatId: string,
  patch: Partial<ProviderChatCascade>,
): boolean {
  const file = chatFile(appDataDir, providerId, chatId);
  if (!file || !existsSync(file)) return false;

  const { meta, messages } = readRecords(file);
  if (!meta?.cascade) return false;

  writeMeta(file, { ...meta, cascade: { ...meta.cascade, ...patch } }, messages);
  return true;
}

/** Удалить разговор вместе с файлом. */
export function deleteChat(appDataDir: string, providerId: string, chatId: string): boolean {
  const file = chatFile(appDataDir, providerId, chatId);
  if (!file || !existsSync(file)) return false;

  rmSync(file, { force: true });
  return true;
}
