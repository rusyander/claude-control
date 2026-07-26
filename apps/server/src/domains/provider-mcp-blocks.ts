import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { UnrecognizedFormatError, readContinueServers } from '../lib/continue-yaml.ts';
import type { ContinueRawServer } from '../lib/continue-yaml.ts';
import { readTextFile } from '../lib/safe-io.ts';

/**
 * Файлы-блоки MCP у Continue.
 *
 * Кроме основного `config.yaml` Continue грузит отдельные файлы-блоки из папки
 * `mcpServers/` (задокументировано для рабочей папки: `.continue/mcpServers/`;
 * глобальную `~/.continue/mcpServers/` сканирует тот же код CLI). Каждый файл —
 * самостоятельный блок: шапка `name` / `version` / `schema: v1` и СВОЙ список
 * `mcpServers` той же формы, что и в основном конфиге:
 *
 *     name: Playwright mcpServer
 *     version: 0.0.1
 *     schema: v1
 *     mcpServers:
 *       - name: Browser search
 *         command: npx
 *         args: ["@playwright/mcp@latest"]
 *
 * Раньше панель этих файлов не видела: раздел показывал только `config.yaml`, и
 * сервер, заведённый блоком, выглядел отсутствующим — человек заводил дубль, а
 * Continue потом грузил оба. Теперь блоки читаются вместе с основным файлом, а
 * правка идёт в тот файл, где запись лежит.
 *
 * FAIL-CLOSED, по файлам ПОРОЗНЬ. Блок может содержать то, чего панель не
 * моделирует: ссылку на хаб (`- uses: continuedev/...`, у записи нет имени),
 * список не тем узлом, повтор имени. Такой файл целиком отправляется в
 * `skipped` — он не показывается и не правится, но и не портится. Один
 * непонятный блок не гасит весь раздел: остальные файлы работают.
 *
 * Своих файлов панель не создаёт: новый сервер идёт в `config.yaml`. Файл-блок
 * появляется только тогда, когда его завёл человек или сам Continue.
 */

/** Расширения файлов-блоков. JSON-файл (`mcp.json`) — отдельная, своя ветка. */
const BLOCK_EXTENSIONS = ['.yaml', '.yml'];

/** Причина, по которой файл-блок пропущен: её видит человек в разделе. */
export interface SkippedMcpBlock {
  path: string;
  reason: string;
}

/** Записи одного файла-блока, как они лежат в нём. */
export interface McpBlockFile {
  path: string;
  servers: ContinueRawServer[];
}

/** Результат обхода папки блоков: разобранные файлы и пропущенные с причиной. */
export interface McpBlockScan {
  files: McpBlockFile[];
  skipped: SkippedMcpBlock[];
}

const UNPARSED_REASON =
  'Файл-блок не разбирается моделью панели (например, запись без имени или ссылка `uses:`) — ' +
  'панель его не показывает и не правит.';

const DUPLICATE_REASON =
  'Имя MCP-сервера из этого файла уже занято другим файлом — панель не может однозначно ' +
  'адресовать запись и файл не трогает.';

/** Файлы-блоки папки в устойчивом порядке (по имени): порядок обхода не должен «плавать». */
function blockFilesOf(dir: string): string[] {
  if (!existsSync(dir)) return [];

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // Папка есть, но недоступна на чтение — это не повод ронять весь раздел.
    return [];
  }

  return names
    .filter((name) => BLOCK_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext)))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => join(dir, name))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
}

/**
 * Прочитать папку блоков. `taken` — имена, уже занятые основным конфигом (и
 * прочитанными ранее блоками): совпадение делает запись неадресуемой, поэтому
 * весь файл уходит в `skipped`, а не «побеждает» кто-то один молча.
 */
export function scanMcpBlocks(dir: string | undefined, taken: Iterable<string>): McpBlockScan {
  if (!dir) return { files: [], skipped: [] };

  const names = new Set(taken);
  const files: McpBlockFile[] = [];
  const skipped: SkippedMcpBlock[] = [];

  for (const path of blockFilesOf(dir)) {
    let servers: ContinueRawServer[];
    try {
      const text = readTextFile(path);
      servers = text.trim() ? readContinueServers(text) : [];
    } catch (error) {
      if (error instanceof UnrecognizedFormatError) {
        skipped.push({ path, reason: UNPARSED_REASON });
        continue;
      }
      throw error;
    }

    const clash = servers.some((server) => names.has(String(server.name)));
    if (clash) {
      skipped.push({ path, reason: DUPLICATE_REASON });
      continue;
    }

    servers.forEach((server) => names.add(String(server.name)));
    files.push({ path, servers });
  }

  return { files, skipped };
}

/** Файл-блок, в котором лежит сервер с этим именем (иначе `undefined`). */
export function findBlockOf(scan: McpBlockScan, serverName: string): McpBlockFile | undefined {
  return scan.files.find((file) => file.servers.some((server) => server.name === serverName));
}
