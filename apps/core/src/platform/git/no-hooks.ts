import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Выкладка копии без хуков проекта (04:133: хуки идут на НАШИХ commit/push, не на checkout копии).
 * Каталог хуков — свежий пустой `mkdtemp` (0700, имя случайное), снимается после вызова. Постоянное
 * имя в общем temp (`/tmp` Linux общий для всех) другой пользователь создал бы первым и положил туда
 * post-checkout — git исполнил бы его от имени ядра.
 */
export async function withNoHooks<T>(run: (hooksArgs: string[]) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-no-hooks-'));
  try {
    return await run(['-c', `core.hooksPath=${dir}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
