import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonFile } from '../../lib/safe-io.ts';
import type { ChatRunRegistry } from './ChatRunRegistry.ts';

/**
 * Заголовок повторной отправки из очереди сервера. Такой запрос потока не
 * держит: читать его некому — человек уже получил ответ «в очереди», а вкладки
 * подхватят новый прогон опросом идущих.
 */
export const QUEUED_SEND_HEADER = 'x-agentdeck-queued';

/**
 * Сообщение занятому разговору — в очередь сервера, до конца идущего хода.
 *
 * Зачем на сервере: хаб родителя отвечает ребёнку-группе, чей прогон вкладка
 * не знает (отцепленная группа, прогон заведён конвейером или другой
 * вкладкой). Очередь вкладки о нём не ведает, и отправка упиралась в 409 —
 * ответ человека пропадал. Сервер знает прогон по любому ключу, включая
 * sessionId, и потому ставит сообщение за ним сам.
 *
 * Ход кончился — `deliver` зовётся вне завершения прогона: новый старт того же
 * разговора изнутри `finish` заменил бы закрывающийся. Ход остановили («Стоп»,
 * пауза группы, отмена плана) — сообщение НЕ уходит (`dropped`): иначе оно тут
 * же заводило новый прогон и снимало только что поставленную паузу.
 */
export function queueAfterRun(
  registry: Pick<ChatRunRegistry, 'attach'>,
  runId: string,
  deliver: () => void,
  defer: (run: () => void) => void = (run) => void setTimeout(run, 0),
  dropped: () => void = () => undefined,
): void {
  let fired = false;
  const fire = (reason?: 'stopped'): void => {
    if (fired) return;
    fired = true;
    if (reason === 'stopped') dropped();
    else defer(deliver);
  };
  // Буфер прогона не нужен — только его конец: подписка с конца буфера.
  const unsubscribe = registry.attach(runId, Number.MAX_SAFE_INTEGER, {
    send: () => undefined,
    close: fire,
  });
  // Ход кончился между проверкой «занят» и подпиской — доставить сразу.
  if (!unsubscribe) fire();
}

/** Файл очереди в каталоге данных панели. */
export const QUEUED_SENDS_FILE = 'queued-sends.json';

/** Сообщение, ждущее конца чужого хода. */
export interface QueuedSend {
  id: string;
  chatId: string;
  /** Тело `/api/chat/send` как есть — уйдёт тем же маршрутом. */
  body: unknown;
  queuedAt: string;
}

/**
 * Очередь на диске (итоговое ревью 25.09, m7). Вкладка уже сказала человеку
 * «встал в очередь», а очередь жила в памяти процесса: перезапуск панели молча
 * терял ответ. Запись снимается по доставке или по остановке хода; оставшееся
 * после перезапуска доставляется заново (`registerChatRunRoutes`).
 */
export class QueuedSendJournal {
  private readonly path?: string;

  /** `appDataDir` нет — очередь только в памяти (тесты, поднимающие одни маршруты). */
  constructor(appDataDir?: string) {
    this.path = appDataDir ? join(appDataDir, QUEUED_SENDS_FILE) : undefined;
  }

  all(): QueuedSend[] {
    if (!this.path || !existsSync(this.path)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (entry): entry is QueuedSend =>
          Boolean(entry) &&
          typeof (entry as QueuedSend).id === 'string' &&
          typeof (entry as QueuedSend).chatId === 'string',
      );
    } catch {
      // Битый файл — очередь пуста: хуже потерять её, чем уронить сервер.
      return [];
    }
  }

  add(entry: QueuedSend): void {
    this.write([...this.all().filter((known) => known.id !== entry.id), entry]);
  }

  remove(id: string): void {
    const rest = this.all().filter((known) => known.id !== id);
    this.write(rest);
  }

  private write(entries: QueuedSend[]): void {
    if (!this.path) return;
    try {
      writeJsonFile(this.path, entries);
    } catch {
      // Отказ диска не должен ронять отправку: очередь в памяти работает и так.
    }
  }
}
