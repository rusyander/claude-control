import { spawn } from 'node:child_process';
import type { McpServer, McpServerDraft, McpHealth } from '@claude-control/contracts';
import { readJsonFile, writeJsonFile } from '../lib/safe-io.ts';
import type { AppStore } from '../lib/app-store.ts';

/**
 * Регистрация MCP-серверов живёт в ~/.claude.json — рядом с каталогом .claude,
 * а не внутри него. Файл общий: помимо mcpServers там истории проектов и
 * настройки, поэтому читаем и пишем его целиком, меняя только свою секцию.
 */

interface RawMcpServer {
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

interface RawMcpConfig {
  mcpServers?: Record<string, RawMcpServer>;
  [key: string]: unknown;
}

/** Секция, куда приложение прячет выключенные серверы. Claude Code её игнорирует. */
const DISABLED_KEY = 'mcpServersDisabled';

export function readMcpServers(mcpConfigPath: string, store: AppStore): McpServer[] {
  const config = readJsonFile<RawMcpConfig>(mcpConfigPath, {});
  const active = config.mcpServers ?? {};
  const disabled = (config[DISABLED_KEY] as Record<string, RawMcpServer> | undefined) ?? {};

  const toServer = (name: string, raw: RawMcpServer, isEnabled: boolean): McpServer => ({
    id: name,
    name,
    transport: (raw.type as McpServer['transport']) ?? (raw.url ? 'http' : 'stdio'),
    command: raw.command,
    args: raw.args ?? [],
    url: raw.url,
    env: raw.env ?? {},
    headers: raw.headers ?? {},
    health: isEnabled ? 'unknown' : 'disabled',
    isEnabled,
    groupIds: store.getGroupIdsFor('mcp', name),
  });

  return [
    ...Object.entries(active).map(([name, raw]) => toServer(name, raw, true)),
    ...Object.entries(disabled).map(([name, raw]) => toServer(name, raw, false)),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

export function saveMcpServer(
  mcpConfigPath: string,
  serverId: string | null,
  draft: McpServerDraft,
  backupDir?: string,
): string | undefined {
  const config = readJsonFile<RawMcpConfig>(mcpConfigPath, {});
  config.mcpServers ??= {};

  // Переименование: убираем запись под старым именем.
  if (serverId && serverId !== draft.name) delete config.mcpServers[serverId];

  const raw: RawMcpServer = { type: draft.transport };
  if (draft.command) raw.command = draft.command;
  if (draft.args.length > 0) raw.args = draft.args;
  if (draft.url) raw.url = draft.url;
  if (Object.keys(draft.env).length > 0) raw.env = draft.env;
  if (Object.keys(draft.headers).length > 0) raw.headers = draft.headers;

  config.mcpServers[draft.name] = raw;
  return writeJsonFile(mcpConfigPath, config, { backupDir });
}

/** Включение и выключение — перенос записи между двумя секциями файла. */
export function setMcpServerEnabled(
  mcpConfigPath: string,
  serverId: string,
  isEnabled: boolean,
  backupDir?: string,
): string | undefined {
  const config = readJsonFile<RawMcpConfig>(mcpConfigPath, {});
  config.mcpServers ??= {};
  const disabled = ((config[DISABLED_KEY] as Record<string, RawMcpServer>) ??= {});

  const from = isEnabled ? disabled : config.mcpServers;
  const to = isEnabled ? config.mcpServers : disabled;
  const entry = from[serverId];
  if (!entry) return undefined;

  delete from[serverId];
  to[serverId] = entry;
  return writeJsonFile(mcpConfigPath, config, { backupDir });
}

export function deleteMcpServer(
  mcpConfigPath: string,
  serverId: string,
  backupDir?: string,
): string | undefined {
  const config = readJsonFile<RawMcpConfig>(mcpConfigPath, {});
  delete config.mcpServers?.[serverId];
  delete (config[DISABLED_KEY] as Record<string, RawMcpServer> | undefined)?.[serverId];
  return writeJsonFile(mcpConfigPath, config, { backupDir });
}

export interface HealthResult {
  health: McpHealth;
  detail?: string;
  toolCount?: number;
}

/**
 * Проверка живости: поднимаем сервер и говорим с ним на языке MCP —
 * initialize, затем tools/list. Это честнее, чем просто проверить наличие файла:
 * видно и что процесс стартует, и сколько инструментов он отдаёт.
 */
export async function checkMcpHealth(server: McpServer, timeoutMs = 30_000): Promise<HealthResult> {
  if (!server.isEnabled) return { health: 'disabled' };
  if (server.transport !== 'stdio') {
    // Для sse/http достаточно проверить доступность адреса.
    return checkHttpHealth(server, timeoutMs);
  }
  if (!server.command) return { health: 'failed', detail: 'Не задана команда запуска' };

  return new Promise<HealthResult>((resolve) => {
    const child = spawn(server.command as string, server.args, {
      env: { ...process.env, ...server.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(server.command as string),
      windowsHide: true,
    });

    let buffer = '';
    let stderr = '';
    let settled = false;

    const finish = (result: HealthResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };

    const timer = setTimeout(
      () =>
        finish({ health: 'failed', detail: stderr.slice(0, 400) || 'Сервер не ответил вовремя' }),
      timeoutMs,
    );

    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => finish({ health: 'failed', detail: error.message }));
    child.on('exit', (code) => {
      if (code !== 0)
        finish({
          health: 'failed',
          detail: stderr.slice(0, 400) || `Процесс завершился с кодом ${code}`,
        });
    });

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let message: { id?: number; result?: { tools?: unknown[] } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.id === 1 && message.result) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2) {
          finish({ health: 'connected', toolCount: message.result?.tools?.length ?? 0 });
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'claude-control', version: '0.1.0' },
      },
    });
  });
}

async function checkHttpHealth(server: McpServer, timeoutMs: number): Promise<HealthResult> {
  if (!server.url) return { health: 'failed', detail: 'Не задан адрес' };

  try {
    const response = await fetch(server.url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(timeoutMs),
      headers: server.headers,
    });
    return response.ok || response.status === 405
      ? { health: 'connected' }
      : { health: 'failed', detail: `HTTP ${response.status}` };
  } catch (error) {
    return { health: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
}
