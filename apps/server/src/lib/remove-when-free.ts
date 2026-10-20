import { rmSync } from 'node:fs';

/**
 * Коды, которыми Windows отвечает, пока каталог держит уходящий процесс: его
 * рабочий каталог (EBUSY/EPERM) или файл, который он ещё дописывает
 * (ENOTEMPTY — файл появился между обходом и снятием каталога).
 */
const HELD = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

const STEP_MS = 200;

const removeTree = (dir: string) => rmSync(dir, { recursive: true, force: true });

/**
 * Снять каталог, который ещё держит уходящий процесс. Под нагрузкой полного
 * прогона Windows отдаёт каталог вышедшего CLI (и его обёртки `cmd.exe`) через
 * секунды, и `maxRetries` у `rmSync` в это окно не укладывался. Ждём
 * освобождения до срока; не освободился — падаем настоящей ошибкой, а не
 * оставляем каталог молча.
 */
export async function removeWhenFree(
  dir: string,
  timeoutMs = 15_000,
  remove: (dir: string) => void = removeTree,
): Promise<void> {
  for (let waited = 0; ; waited += STEP_MS) {
    try {
      remove(dir);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!HELD.has(code) || waited >= timeoutMs) throw error;
      await new Promise((done) => setTimeout(done, STEP_MS));
    }
  }
}
