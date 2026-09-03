import { existsSync } from 'node:fs';
import type { McpServer, UniversalMcpServer } from '@claude-control/contracts';
import { providerSettingsSource } from '../../providers/registry.ts';
import { readTextFile } from '../../lib/safe-io.ts';
import { sortedJson } from '../../lib/sorted-json.ts';
import { resolveProviderMcpTarget, readProviderMcpServers } from '../provider-mcp.ts';
import {
  resolveProviderPermissionsTarget,
  readProviderPermissions,
} from '../provider-permissions.ts';
import { resolveProviderEnvTarget, readProviderEnvVars } from '../provider-env.ts';
import { resolveInstructionsTarget } from '../instructions.ts';
import type { CompareDeps, Row, SideRead } from './types.ts';

/**
 * Чтение одного раздела у одной стороны: у Claude — внедрёнными читателями
 * (`ClaudeSide`), у прочих — универсальными адаптерами. Каждый раздел приводится
 * к паре «ключ → показываемое значение» плюс, где надо, значение для сравнения
 * ПО СМЫСЛУ и данные для переноса.
 */

/** Ключ, под которым в разделе инструкций живёт единственная запись — сам файл. */
const INSTRUCTIONS_KEY = 'Файл инструкций';

/** Имена, по которым переменная считается секретом. Тот же признак, что в разделе env. */
const SECRET_HINT = /(TOKEN|SECRET|KEY|PASSWORD|PAT|CREDENTIAL)/i;

function unsupported(note: string): SideRead {
  return { supported: false, note, rows: [] };
}

/** Формат файла не распознан — читать его панель не станет (одинаково у всех разделов). */
function unreadable(filePath: string): SideRead {
  return {
    supported: false,
    filePath,
    note: 'Формат файла не распознан — читать его панель не станет.',
    rows: [],
  };
}

/**
 * Файла ещё нет — раздел у CLI поддержан, записей ноль, и колонка ГОВОРИТ об
 * этом, а не стоит пустой. Раньше отсутствие файла (CLI не установлен или ничего
 * не настроил) выглядело ровно как «настроено, но пусто». Сторона остаётся
 * `supported`: перенос СЮДА возможен — запись создаст файл.
 */
function absent(filePath: string): SideRead {
  return {
    supported: true,
    filePath,
    note: 'Файла нет — CLI не установлен или ещё ничего не настроил. Перенос сюда создаст файл.',
    rows: [],
  };
}

export function mcpSide(providerId: string, deps: CompareDeps): SideRead {
  if (providerId === 'claude') {
    const servers = deps.claude.readMcp();
    return {
      supported: true,
      filePath: deps.claude.mcpConfigPath,
      rows: servers.map((server) => mcpRow(claudeToUniversal(server), server)),
    };
  }

  const target = resolveProviderMcpTarget(
    providerSettingsSource(providerId, deps.claudeDirOverride),
  );
  if (!target) return unsupported('У этого CLI панель не ведёт MCP-серверы.');
  if (!existsSync(target.filePath)) return absent(target.filePath);

  try {
    return {
      supported: true,
      filePath: target.filePath,
      rows: readProviderMcpServers(target).map((server) => mcpRow(server)),
    };
  } catch {
    return unreadable(target.filePath);
  }
}

/**
 * Богатая модель Claude → переносимый субсет. Транспорт `sse` в него не входит:
 * у чужих CLI его нет, и подменять его на http значило бы записать сервер, к
 * которому CLI не подключится.
 */
function claudeToUniversal(server: McpServer): UniversalMcpServer {
  return {
    name: server.name,
    transport: server.transport === 'stdio' ? 'stdio' : 'http',
    command: server.command,
    args: server.args,
    env: server.env,
    url: server.url,
    headers: server.headers,
  };
}

function mcpRow(server: UniversalMcpServer, claude?: McpServer): Row {
  const blocked =
    claude && claude.transport === 'sse'
      ? 'Транспорт sse: у других CLI его нет, переносить некуда.'
      : claude && !claude.isEnabled
        ? 'Сервер выключен — переносим только включённые.'
        : undefined;

  return {
    key: server.name,
    display:
      server.transport === 'stdio'
        ? `stdio · ${[server.command, ...server.args].filter(Boolean).join(' ')}`
        : `http · ${server.url ?? ''}`,
    compare: sortedJson({
      transport: server.transport,
      command: server.command ?? '',
      args: server.args,
      url: server.url ?? '',
      env: server.env,
      headers: server.headers,
    }),
    blocked,
    payload: server,
  };
}

export function envSide(providerId: string, deps: CompareDeps): SideRead {
  if (providerId === 'claude') {
    return {
      supported: true,
      filePath: deps.claude.settingsPath,
      rows: deps.claude.readEnv().map((item) => ({
        key: item.key,
        // Значение приходит уже замаскированным, если это секрет, — маскировать
        // повторно нечего, а показывать больше, чем показывает раздел env, нельзя.
        display: item.value,
        opaque: item.isSecret,
      })),
    };
  }

  const target = resolveProviderEnvTarget(
    providerSettingsSource(providerId, deps.claudeDirOverride),
  );
  if (!target) return unsupported('У этого CLI панель не ведёт переменные окружения.');
  if (!existsSync(target.filePath)) return absent(target.filePath);

  try {
    return {
      supported: true,
      filePath: target.filePath,
      rows: readProviderEnvVars(target).map((item) => {
        const secret = SECRET_HINT.test(item.key);
        return {
          key: item.key,
          display: secret ? maskValue(item.value) : item.value,
          opaque: secret,
        };
      }),
    };
  } catch {
    return unreadable(target.filePath);
  }
}

export function permissionsSide(providerId: string, deps: CompareDeps): SideRead {
  if (providerId === 'claude') {
    return {
      supported: true,
      filePath: deps.claude.settingsPath,
      rows: deps.claude.readPermissions().map((rule) => ({
        key: rule.pattern,
        display: rule.decision,
      })),
    };
  }

  const target = resolveProviderPermissionsTarget(
    providerSettingsSource(providerId, deps.claudeDirOverride),
  );
  if (!target) return unsupported('У этого CLI панель не ведёт права.');
  if (!existsSync(target.filePath)) return absent(target.filePath);

  try {
    const values = readProviderPermissions(target) as unknown as Record<string, unknown>;
    return {
      supported: true,
      filePath: target.filePath,
      rows: flattenValues(values),
    };
  } catch {
    return unreadable(target.filePath);
  }
}

/**
 * Значения прав — объект своей формы у каждого CLI. Раскладываем его в плоские
 * пары «ключ → значение»: списки становятся перечислением, скаляры — собой.
 * Служебный `usingDefaults` (файла ещё нет) в сравнение не идёт: это факт о
 * файле, а не о правах.
 */
function flattenValues(values: Record<string, unknown>): Row[] {
  return Object.entries(values)
    .filter(([key]) => key !== 'usingDefaults')
    .map(([key, value]): Row => {
      if (Array.isArray(value)) {
        return {
          key,
          display: value.length ? value.map(describeItem).join(', ') : '—',
          compare: sortedJson(value),
        };
      }
      if (value && typeof value === 'object') {
        return { key, display: summarizeObject(value), compare: sortedJson(value) };
      }
      return { key, display: value === undefined ? '—' : String(value) };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

function summarizeObject(value: object): string {
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '—';
  return entries.map(([key, item]) => `${key}: ${describeItem(item)}`).join(', ');
}

/**
 * Элемент списка или поля. Права kimi (`rules: [{decision, pattern}]`) и opencode
 * (`entries: [{tool, mode, …}]`) — списки ОБЪЕКТОВ: `String(item)` дал бы
 * «[object Object]» на странице сравнения, поэтому объект раскладывается в свои
 * пары в скобках, вложенный список — через запятую, скаляр — собой.
 */
function describeItem(item: unknown): string {
  if (Array.isArray(item)) return item.map(describeItem).join(', ');
  if (item && typeof item === 'object') return `(${summarizeObject(item)})`;
  return String(item);
}

export function instructionsSide(providerId: string, deps: CompareDeps): SideRead {
  const target = resolveInstructionsTarget(
    providerSettingsSource(providerId, deps.claudeDirOverride),
    deps.claude.claudeMdPath,
  );
  if (!target) {
    return unsupported('У этого CLI глобальные инструкции устроены иначе — не одним файлом.');
  }

  // Файла нет — записей нет: строка появится только у стороны, где файл есть,
  // как «только слева/справа», и перенос в пустую сторону остаётся доступным
  // (запись создаст файл — ровно то, что обещает справка). Раньше отсутствие
  // приёмника блокировало строку целиком: `blocked` считался на СТОРОНЕ, а
  // применялся к записи без учёта направления — переносить CLAUDE.md в ещё не
  // созданный AGENTS.md было нельзя, хотя сервер это умеет.
  if (!existsSync(target.filePath)) return absent(target.filePath);
  const content = readTextFile(target.filePath);

  return {
    supported: true,
    filePath: target.filePath,
    rows: [
      {
        key: INSTRUCTIONS_KEY,
        display: `${target.fileName} · ${sizeOf(content)}`,
        // Сравниваем СОДЕРЖИМОЕ: имена файлов у CLI разные всегда, и разница имён
        // не новость. Интересно, одинаков ли текст.
        compare: content,
      },
    ],
  };
}

function sizeOf(content: string): string {
  const bytes = Buffer.byteLength(content, 'utf8');
  return bytes < 1024 ? `${bytes} Б` : `${(bytes / 1024).toFixed(1)} КБ`;
}

/** Маска секрета: как в разделе env — видно начало и хвост, середины нет. */
function maskValue(value: string): string {
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 3)}••••${value.slice(-2)}`;
}
