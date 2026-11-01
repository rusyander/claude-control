import { join } from 'node:path';
import { writeFileAtomic } from '../platform/safe-io/atomic-write.ts';
import { readBytesSync } from '../platform/safe-io/files.ts';

/**
 * Ключи маршрута, которые дорога сессии прочитала для сеанса (P61): значения — маске `known`
 * (бриф, пакет ревью, `unit_diff`, ответ `check`), даже если имя переменной не похоже на секрет
 * (`LLAMA_ACCESS`). Значение живёт только в памяти; на диск (`session-state/<id>.key-names.json`)
 * ложится ИМЯ переменной пина — после перезапуска ядра значение снова берётся из пина.
 */

export interface SessionKeyBook {
  /** Дорога прочитала ключ `env` для сеанса: имя переменной пина и её значение. */
  record(sessionId: string, name: string, value: string): void;
  /** Значения ключей сеанса: память, иначе имена с диска по пину. */
  valuesOf(sessionId: string, pin: Readonly<Record<string, string>>): string[];
}

/** Id сеанса — UUIDv7; иное в путь файла не идёт (только память). */
const SAFE_ID = /^[0-9A-Za-z-]{1,64}$/;

interface NamesFile {
  v: 1;
  names: string[];
}

export function createSessionKeyBook(stateDir: string | undefined): SessionKeyBook {
  const values = new Map<string, Map<string, string>>();
  const fileOf = (sessionId: string): string | undefined =>
    stateDir && SAFE_ID.test(sessionId) ? join(stateDir, `${sessionId}.key-names.json`) : undefined;
  const namesOnDisk = (sessionId: string): string[] => {
    const file = fileOf(sessionId);
    if (!file) return [];
    const bytes = readBytesSync(file);
    if (!('value' in bytes)) return [];
    try {
      const doc = JSON.parse(bytes.value.toString('utf8')) as Partial<NamesFile>;
      return Array.isArray(doc.names) ? doc.names.filter((n) => typeof n === 'string') : [];
    } catch {
      return [];
    }
  };
  return {
    record(sessionId, name, value) {
      const mine = values.get(sessionId) ?? new Map<string, string>();
      mine.set(name, value);
      values.set(sessionId, mine);
      const file = fileOf(sessionId);
      if (file) {
        const doc: NamesFile = { v: 1, names: [...mine.keys()] };
        writeFileAtomic(file, `${JSON.stringify(doc)}\n`);
      }
    },
    valuesOf(sessionId, pin) {
      const mine = values.get(sessionId);
      if (mine) return [...mine.values()];
      return namesOnDisk(sessionId)
        .map((name) => pin[name])
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
    },
  };
}
