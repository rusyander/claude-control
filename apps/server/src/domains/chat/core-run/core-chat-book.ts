import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CoreChatBook, CoreChatEntry } from './core-run.types.ts';

/**
 * Книга разговоров чата на ядре (этап 10, F2, проход 3): id разговора CLI → задача ядра и её шаг
 * `chat`. Лежит файлом в данных панели: после перезапуска панели ход человека идёт сообщением
 * живому шагу (`message-to-step`), а не новой задачей с продолжением транскрипта.
 *
 * Запись, которой ядро уже не знает (задача кончилась, шаг закрыт), не вредит: прогон сверяет её
 * с видом задачи и при расхождении заводит новую задачу с `resume`.
 */

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function readAll(file: string): Record<string, CoreChatEntry> {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, CoreChatEntry> = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      const e = v as Partial<CoreChatEntry> | null;
      if (SAFE_ID.test(id) && typeof e?.taskId === 'string' && typeof e.stepId === 'string') {
        out[id] = { taskId: e.taskId, stepId: e.stepId };
      }
    }
    return out;
  } catch {
    // Битый файл — книга пуста: худшее — новая задача с продолжением разговора, а не сбой хода.
    return {};
  }
}

export function createCoreChatBook(file: string): CoreChatBook {
  let entries = readAll(file);
  const save = (): void => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`);
    renameSync(tmp, file);
  };
  return {
    get: (id) => entries[id],
    set(id, entry) {
      if (!SAFE_ID.test(id)) return;
      entries = { ...entries, [id]: entry };
      save();
    },
    forget(id) {
      if (!(id in entries)) return;
      const { [id]: _gone, ...rest } = entries;
      entries = rest;
      save();
    },
  };
}
