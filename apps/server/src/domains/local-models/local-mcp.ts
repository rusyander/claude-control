import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { McpServer } from '@agentdeck/contracts';
import type { LocalMcpScope } from '@agentdeck/contracts/local-models';

/**
 * MCP-серверы локального прогона (L4, решение владельца 14.10).
 *
 * Облегчённый набор локального прогона (`--strict-mcp-config`) убирает ВСЕ
 * MCP-серверы: пользовательские, проектный `.mcp.json` и переходник к контуру. Замер
 * 14.10 (настоящий `claude` 2.1.286, слой владельца): основа запроса 42 383 → 12 598
 * токенов, из 29 785 снятых 20 257 — MCP (gitlab 39 инструментов = 15 040, figma
 * 3 140, atlassian 1 421, telegram 656). Без них локальный разбор MR остаётся без
 * GitLab — поэтому человек может ВЗЯТЬ нужные серверы в прогон проекта, видя цену
 * каждого и остаток окна; по умолчанию — ни одного.
 *
 * Здесь — чистое: что считать ценой, как ключевать выбор по проекту, чем
 * заменить замер, когда считать нечем. Сеть и диск — в `service.ts`, чтение
 * конфигураций — в `mcp-source.ts`.
 */

export interface McpToolDef {
  name: string;
  description?: string | undefined;
  inputSchema?: unknown;
}

/** Запись сервера из файла настроек: как её понимает панель и как её отдать Claude Code. */
export interface McpSourceEntry {
  id: string;
  scope: LocalMcpScope;
  transport: McpServer['transport'];
  /** Запись для `--mcp-config` как есть: Claude Code подставит `${VAR}` и войдёт сам. */
  config: Record<string, unknown>;
  /** Запись в виде, которым говорит с сервером клиент панели (замер инструментов). */
  server: McpServer;
}

/** Откуда серверы и как их опросить; подменяется в проверках. */
export interface LocalMcpSource {
  /**
   * Включённые серверы, доступные запуску проекта: пользовательские и проектного `.mcp.json` (проектный сильнее).
   * `approvedOnly` — из `.mcp.json` только те, что человек одобрил для этого проекта в Claude Code.
   */
  list(project: string, options?: { approvedOnly?: boolean }): McpSourceEntry[];
  /** Подключиться и спросить `tools/list`. Бросает, если сервер не ответил. */
  tools(entry: McpSourceEntry): Promise<McpToolDef[]>;
}

/** Итог замера одного сервера. Запись по ключу `scope:id`. */
export interface McpCostRecord {
  /** Отпечаток записи сервера: изменилась команда или адрес — замер устарел. */
  fingerprint: string;
  tokens: number | null;
  tools: number | null;
  source?: 'server' | 'estimate';
  error?: string;
  measuredAt: string;
}

/** Символов на токен, когда счёта сервера моделей нет: JSON схем плотнее прозы. Сверка на настоящем сервере — в отчёте L4. */
export const ESTIMATE_CHARS_PER_TOKEN = 3.2;

/** Неудачный замер повторяется не раньше этого срока, если человек не попросил сам. */
export const ERROR_RETRY_MS = 10 * 60 * 1000;

/** Ключ выбора: проект без различий регистра на Windows и без хвостового разделителя. */
export function projectKeyOf(
  project: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const full = resolve(project).replace(/[\\/]+$/, '');
  return platform === 'win32' ? full.toLowerCase() : full;
}

export function costKeyOf(entry: Pick<McpSourceEntry, 'scope' | 'id'>): string {
  return `${entry.scope}:${entry.id}`;
}

export function fingerprintOf(entry: McpSourceEntry): string {
  return createHash('sha1').update(JSON.stringify(entry.config)).digest('hex').slice(0, 16);
}

/**
 * Инструменты в том виде, в каком их шлёт Claude Code: имя `mcp__<сервер>__<инструмент>`,
 * описание и схема входа. Считается ЭТОТ набор: цена в окне — это его токены.
 */
export function toolsPayload(entry: Pick<McpSourceEntry, 'id'>, tools: McpToolDef[]): unknown[] {
  return tools.map((tool) => ({
    name: `mcp__${entry.id}__${tool.name}`,
    description: tool.description ?? '',
    input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
  }));
}

export function estimateTokens(payload: unknown[]): number {
  return Math.ceil(JSON.stringify(payload).length / ESTIMATE_CHARS_PER_TOKEN);
}

/** Нужен ли замер: записи нет, запись о другом сервере, прикидка при живом счёте, давняя неудача. */
export function needsMeasure(
  record: McpCostRecord | undefined,
  entry: McpSourceEntry,
  options: { serverCounts: boolean; now: number },
): boolean {
  if (!record || record.fingerprint !== fingerprintOf(entry)) return true;
  if (record.error) return options.now - Date.parse(record.measuredAt) >= ERROR_RETRY_MS;
  return record.source === 'estimate' && options.serverCounts;
}

/**
 * Замерить один сервер: `tools/list` → цена. `count` — счёт токенов сервера
 * моделей (насчитанное минус пустой запрос); нет его — прикидка по символам.
 */
export async function measureEntry(input: {
  entry: McpSourceEntry;
  source: LocalMcpSource;
  count?: (tools: unknown[]) => Promise<number>;
  now?: () => Date;
}): Promise<McpCostRecord> {
  const { entry } = input;
  const measuredAt = (input.now?.() ?? new Date()).toISOString();
  const fingerprint = fingerprintOf(entry);
  let tools: McpToolDef[];
  try {
    tools = await input.source.tools(entry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { fingerprint, tokens: null, tools: null, error: message.slice(0, 300), measuredAt };
  }
  const payload = toolsPayload(entry, tools);
  if (input.count) {
    try {
      return {
        fingerprint,
        tokens: Math.max(0, Math.round(await input.count(payload))),
        tools: tools.length,
        source: 'server',
        measuredAt,
      };
    } catch {
      // Сервер моделей не ответил (занят, нет ручки) — ниже прикидка, а не провал замера.
    }
  }
  return {
    fingerprint,
    tokens: estimateTokens(payload),
    tools: tools.length,
    source: 'estimate',
    measuredAt,
  };
}
