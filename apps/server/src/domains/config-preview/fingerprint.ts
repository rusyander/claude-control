import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ClaudeLocation } from '@agentdeck/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import { readJsonFile } from '../../lib/safe-io.ts';
import { isLocalId } from '../../lib/settings-source.ts';

type ClaudePaths = ClaudeLocation['paths'];

/** Вид запроса предпросмотра — ровно то, что нужно, чтобы назвать исходники. */
export interface FingerprintTarget {
  kind: 'rule' | 'skill' | 'permission' | 'mcp';
  action: string;
  id?: string;
  /** Места скилла (включённый и выключенный каталог) — их решает сам предпросмотр. */
  skillPlaces?: string[];
}

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** Байты файла свёрнутые в хеш; отсутствие файла — тоже состояние. */
function fileHash(path: string): string {
  return existsSync(path) ? sha(readFileSync(path)) : 'absent';
}

/** Все файлы каталога (путь → хеш): удаление папки уносит каждый из них. */
function dirHashes(dir: string): Record<string, string> {
  if (!existsSync(dir)) return { [dir]: 'absent' };
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    files[relative(dir, full).replaceAll('\\', '/')] = fileHash(full);
  }
  return files;
}

/**
 * Отпечаток исходного состояния, из которого посчитан предпросмотр: байты
 * целевых файлов и отметки панели, влияющие на итог. Сверяется перед записью
 * одобренной карточки (`stale_preview`).
 *
 * `~/.claude.json` целиком не хешируется: Claude Code сам пишет туда счётчики и
 * истории проектов на каждом запуске, и любая карточка MCP устаревала бы от
 * работы соседнего терминала. Писатель MCP трогает только секции серверов —
 * они и есть отпечаток; остальное он перечитывает при записи и сохраняет.
 */
export function configSourceFingerprint(
  paths: ClaudePaths,
  store: AppStore,
  target: FingerprintTarget,
): string {
  let sources: unknown;
  switch (target.kind) {
    case 'rule':
      sources = {
        claudeMd: fileHash(paths.claudeMd),
        disabled: store.getDisabledIds('rule'),
      };
      break;
    case 'skill':
      sources = (target.skillPlaces ?? []).map((place) =>
        target.action === 'delete' ? dirHashes(place) : fileHash(join(place, 'SKILL.md')),
      );
      break;
    case 'permission':
      sources = {
        file: fileHash(
          target.id !== undefined && isLocalId(target.id) ? paths.settingsLocal : paths.settings,
        ),
        disabled: store.getDisabledIds('permission'),
      };
      break;
    default: {
      const config = readJsonFile<Record<string, unknown>>(paths.mcpConfig, {});
      sources = sha(
        JSON.stringify({
          servers: config.mcpServers ?? null,
          disabled: config.mcpServersDisabled ?? null,
        }),
      );
    }
  }
  return sha(JSON.stringify(sources));
}
