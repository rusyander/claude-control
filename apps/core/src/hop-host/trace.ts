import { openAppendLog, type AppendLog } from '../platform/safe-io/append-log.ts';
import type { HopTraceEntry } from './host.types.ts';

/**
 * След звена (`<home>/hops/trace.jsonl`) — замена журнала нарушений панели (план §2 H
 * «violations → hop trace file the panel may read»). Строка на запрос: статус, код отказа,
 * названия проверок, маска, потери, токены. Тела запроса, ключа и заглушки здесь нет никогда:
 * файл читает панель, и он не должен становиться вторым местом, где лежит промпт.
 */
export class HopTrace {
  readonly #log: AppendLog;

  constructor(path: string) {
    this.#log = openAppendLog(path);
  }

  write(entry: HopTraceEntry): void {
    try {
      this.#log.append(Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8'));
    } catch {
      // След не останавливает запрос: ответ модели уже идёт клиенту, а сбой диска виден в статусе.
    }
  }

  close(): void {
    this.#log.close();
  }
}
