import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Содержимое папки целиком: путь → sha256. Равенство до и после отказа = агент
 * по незарегистрированной папке не записал ни байта. Только для тестов.
 */
export function folderSnapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    out[relative(root, file)] = createHash('sha256').update(readFileSync(file)).digest('hex');
  }
  return out;
}
