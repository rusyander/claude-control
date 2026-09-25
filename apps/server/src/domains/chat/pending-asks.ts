import { existsSync, readFileSync } from 'node:fs';
import type { ChatTreeAsk } from '@agentdeck/contracts/chat-handoff';
import { writeJsonFile } from '../../lib/safe-io.ts';
import { endsWithQuestion } from './chain-outcome.ts';
import type { ChatEvent } from './chat-events.ts';
import type { ChatRunRegistry, RunFinished } from './ChatRunRegistry.ts';
import { findTranscript, readTailRecords } from './ChatTranscriptFile.ts';

/**
 * Вопросы и запросы прав разговоров дерева, записанные сервером (WP9c).
 *
 * Хаб родителя собирал их из потока прогона во ВКЛАДКЕ, а у группы, которую
 * запустил конвейер, продолжение или перезапуск панели, вкладки нет: вопрос
 * уходил в пустоту, карточки не было ни в родителе, ни после F5, и группа
 * часами стояла «на человеке», о котором человек не знал (журнал 30, 36, 62,
 * 76). Вопрос, заданный одним текстом, не доходил вовсе (журнал 97 g7, 124).
 *
 * Поэтому запись — на сервере и в файле панели:
 *
 * - вызов `AskUserQuestion` и запрос прав записываются по событию прогона;
 * - ход, кончившийся вопросом текстом, — по его концу; у усыновлённого прогона
 *   (потока нет) тело вызова берётся из хвоста транскрипта;
 * - следующий ход разговора снимает всё: ответ дошёл, а на новый вопрос будет
 *   новая запись; решение по правам снимает свой запрос сразу;
 * - после перезапуска панели запись читается из файла — вопрос остаётся, а
 *   запрос прав показывается, только пока его прогон жив (сервер прав повторит
 *   запрос, и брокер снова будет его ждать).
 *
 * Пишутся только разговоры дерева (`isTreeChat`): у своего разговора вопрос и
 * так в его ленте, и копить их незачем.
 */

/** Запись с ключами разговора: временным `new-…` и настоящим `sessionId`. */
interface PendingAskRecord extends ChatTreeAsk {
  keys: string[];
}

export interface PendingAsksDeps {
  /** Файл записи; нет — только память (тесты домена). */
  file?: string;
  /** Разговор ли дерева разделения — по связи, которую знает хранилище. */
  isTreeChat: (keys: readonly string[]) => boolean;
  /** Тело последнего вызова `AskUserQuestion` из транскрипта (усыновлённый прогон). */
  readAsked?: (chatId: string, sessionId?: string) => unknown;
  now?: () => Date;
}

/** Сколько записей держать: дерево разделения — десятки разговоров, не тысячи. */
const LIMIT = 200;
/** Хвост ответа, кончившегося вопросом текстом: хватает на вопрос с вариантами. */
export const TEXT_ASK_MAX = 1_500;

export class PendingAsks {
  private readonly deps: PendingAsksDeps;
  private records: PendingAskRecord[];

  constructor(deps: PendingAsksDeps) {
    this.deps = deps;
    this.records = deps.file ? readRecords(deps.file) : [];
  }

  /** Событие прогона: вопрос, запрос прав или решение по нему. */
  onEvent(keys: readonly string[], event: ChatEvent): void {
    if (event.kind === 'permissionResolved') {
      this.drop((record) => record.kind === 'permission' && record.toolUseId === event.toolUseId);
      return;
    }
    if (!this.deps.isTreeChat(keys)) return;
    if (event.kind === 'tool' && event.name === 'AskUserQuestion') {
      this.put(keys, {
        kind: 'question',
        runId: keys[0] as string,
        ...(event.id ? { toolUseId: event.id } : {}),
        input: event.input,
        askedAt: this.now(),
      });
    }
    if (event.kind === 'permission') {
      this.put(keys, {
        kind: 'permission',
        runId: keys[0] as string,
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        input: event.input,
        askedAt: this.now(),
      });
    }
  }

  /** Новый ход разговора: прежние вопросы отвечены, прежний процесс прав не ждёт. */
  started(keys: readonly string[]): void {
    this.drop((record) => overlaps(record.keys, keys));
  }

  /**
   * Ждать больше нечего: план разделения отменён человеком, и вопрос закрытой
   * группы, оставшись в записи, звал бы «агент ждёт ответа» у разговора, которого
   * уже никто не ведёт (живой прогон 26.09).
   */
  forget(keys: readonly string[]): void {
    this.drop((record) => overlaps(record.keys, keys));
  }

  /**
   * Ход кончился. Процесса больше нет — его запросы прав сняты. Вопрос
   * инструментом, записанный потоком, остаётся; у усыновлённого прогона потока
   * не было — тело вызова читаем из транскрипта. Вопрос текстом записывается
   * здесь же: это единственный момент, когда ответ известен целиком.
   */
  finished(finished: RunFinished): void {
    try {
      this.record(finished);
    } catch {
      // Молча: зовут из планировщика продолжений, и его работа важнее записи.
    }
  }

  private record(finished: RunFinished): void {
    const keys = finished.sessionId ? [finished.chatId, finished.sessionId] : [finished.chatId];
    this.drop((record) => record.kind === 'permission' && overlaps(record.keys, keys));
    if (!finished.ok || finished.interrupted || !this.deps.isTreeChat(keys)) return;

    const known = this.records.find(
      (record) => record.kind === 'question' && overlaps(record.keys, keys),
    );
    if (known) {
      // Настоящий ключ сессии мог прийти позже вопроса — дописываем.
      known.keys = [...new Set([...known.keys, ...keys])];
      this.save();
      return;
    }
    if (finished.asked) {
      const input = this.readAsked(finished);
      if (input !== undefined) {
        this.put(keys, { kind: 'question', runId: finished.chatId, input, askedAt: this.now() });
        return;
      }
    }
    if (finished.asked || endsWithQuestion(finished.text)) {
      const text = tailOf(finished.text);
      if (text) this.put(keys, { kind: 'text', runId: finished.chatId, text, askedAt: this.now() });
    }
  }

  /**
   * Что ждёт человека у разговора с этими ключами. `alive` — жив ли прогон:
   * запрос прав умершего процесса ответить уже нельзя, и карточка с ним лгала бы.
   */
  of(keys: readonly string[], alive: (runId: string) => boolean): ChatTreeAsk[] {
    return this.records
      .filter((record) => overlaps(record.keys, keys))
      .filter((record) => record.kind !== 'permission' || alive(record.runId))
      .map(({ keys: _keys, ...ask }) => ask);
  }

  private readAsked(finished: RunFinished): unknown {
    try {
      return this.deps.readAsked?.(finished.chatId, finished.sessionId);
    } catch {
      return undefined;
    }
  }

  private put(keys: readonly string[], ask: ChatTreeAsk): void {
    // Тот же вызов дважды (сервер прав повторил запрос после перезапуска) —
    // одна запись; вопрос у разговора один — последний.
    this.drop(
      (record) =>
        overlaps(record.keys, keys) &&
        (ask.kind === 'permission'
          ? record.kind === 'permission' && record.toolUseId === ask.toolUseId
          : record.kind !== 'permission'),
      false,
    );
    this.records.push({ ...ask, keys: [...keys] });
    this.records = this.records.slice(-LIMIT);
    this.save();
  }

  private drop(match: (record: PendingAskRecord) => boolean, persist = true): void {
    const next = this.records.filter((record) => !match(record));
    if (next.length === this.records.length) return;
    this.records = next;
    if (persist) this.save();
  }

  private save(): void {
    if (!this.deps.file) return;
    try {
      writeJsonFile(this.deps.file, this.records);
    } catch {
      // Запись — для хаба: отказ диска не имеет права уронить прогон.
    }
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}

/**
 * Чьи вопросы пишутся: у разговора есть родитель — по любому его ключу. Не
 * только группы разделения: чат, заведённый из родителя вручную (параллельный
 * запуск, отдельная задача), тоже стоит ветвью в его хабе, и запрос прав,
 * который авторежим CLI всё же отдал человеку (откат `git checkout -- <файл>`),
 * обязан быть виден там, а не только в самом чате (владелец, 24.09.2026).
 */
export function hasParentLink(
  linkOf: (key: string) => { parentChatId?: string } | undefined,
): (keys: readonly string[]) => boolean {
  return (keys) => keys.some((key) => Boolean(linkOf(key)?.parentChatId));
}

/** Файл записи в каталоге данных панели — рядом с журналом прогонов. */
export const PENDING_ASKS_FILE = 'pending-asks.json';

/**
 * Запись, подписанная на события реестра. Начало и конец хода сюда не
 * подписаны: у реестра на них по одному слушателю, и их собирает bootstrap —
 * он зовёт `started`/`finished` рядом с конвейером и повторами.
 */
export function wirePendingAsks(
  registry: Pick<ChatRunRegistry, 'setAskListener'>,
  deps: PendingAsksDeps,
): PendingAsks {
  const asks = new PendingAsks(deps);
  registry.setAskListener((keys, event) => asks.onEvent(keys, event));
  return asks;
}

function overlaps(a: readonly string[], b: readonly string[]): boolean {
  return a.some((key) => b.includes(key));
}

function tailOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > TEXT_ASK_MAX
    ? `…${trimmed.slice(trimmed.length - TEXT_ASK_MAX + 1)}`
    : trimmed;
}

function readRecords(file: string): PendingAskRecord[] {
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is PendingAskRecord {
  const record = value as Partial<PendingAskRecord> | null;
  return (
    typeof record === 'object' &&
    record !== null &&
    Array.isArray(record.keys) &&
    typeof record.runId === 'string' &&
    typeof record.askedAt === 'string' &&
    (record.kind === 'question' || record.kind === 'permission' || record.kind === 'text')
  );
}

/**
 * Тело последнего вызова `AskUserQuestion` в хвосте транскрипта. Хвоста
 * хватает: вопрос — в закрывающем ходе, а он в конце файла.
 */
export function lastAskedInput(projectsDir: string, chatId: string): unknown {
  const path = findTranscript(projectsDir, chatId);
  if (!path) return undefined;
  let input: unknown;
  for (const record of readTailRecords(path, 256 * 1024)) {
    const content = record.message?.content;
    // Реплика человека после вопроса — на него уже ответили.
    if (record.type === 'user' && !record.isMeta && isHumanPrompt(content)) input = undefined;
    if (record.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_use' && block.name === 'AskUserQuestion') input = block.input;
    }
  }
  return input;
}

function isHumanPrompt(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  return (
    Array.isArray(content) &&
    content.some((block: { type?: string }) => block.type !== 'tool_result')
  );
}
