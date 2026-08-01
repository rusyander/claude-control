import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readHooks } from '../hooks.ts';
import { readMcpServers } from '../mcp.ts';
import type { ClaudeLocation } from '@claude-control/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import type { SandboxDescription, SandboxSelection } from './SandboxConfig.types.ts';

/**
 * Настройки песочницы: выбранные хуки и MCP-серверы плюс запреты, которые
 * не дают выйти за её пределы.
 */
export function buildSettings(
  configDir: string,
  selection: SandboxSelection,
  location: ClaudeLocation,
  store: AppStore,
  description: SandboxDescription,
): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    permissions: { deny: denyRules(location) },
  };

  const hooks = collectHooks(configDir, selection, location, store, description);
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;

  const servers = collectMcpServers(selection, location, store, description);
  if (Object.keys(servers).length > 0) settings.mcpServers = servers;

  return settings;
}

/**
 * Границы песочницы. Правки и так разрешены только в рабочей папке, но запреты
 * добавляют второй рубеж: настоящую конфигурацию нельзя ни прочитать, ни
 * изменить, а файл с токенами закрыт целиком.
 */
function denyRules(location: ClaudeLocation): string[] {
  const real = location.paths.root.replace(/\\/g, '/');

  return [
    `Read(${real}/.credentials.json)`,
    `Read(${real}/.mcp-secrets.env)`,
    `Edit(${real}/**)`,
    `Write(${real}/**)`,
    'Bash(rm -rf /*)',
    'Bash(shutdown:*)',
  ];
}

/** Хуки: их описания идут в настройки, а файлы скриптов — рядом. */
function collectHooks(
  configDir: string,
  selection: SandboxSelection,
  location: ClaudeLocation,
  store: AppStore,
  description: SandboxDescription,
): Record<string, unknown[]> {
  if (!selection.hookIds?.length) return {};

  const hooksDir = join(configDir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });

  const result: Record<string, unknown[]> = {};

  for (const hook of readHooks(location.paths.settings, store)) {
    if (!selection.hookIds.includes(hook.id)) continue;

    let command = hook.command;

    // Скрипт копируем в песочницу и подменяем путь: хук должен запускать
    // копию, иначе правки в песочнице задели бы настоящий файл.
    if (hook.scriptPath && existsSync(hook.scriptPath)) {
      const name = hook.scriptPath.split(/[\\/]/).pop() ?? 'hook.mjs';
      const target = join(hooksDir, name);

      copyFileSync(hook.scriptPath, target);
      command = command.split(hook.scriptPath).join(target);
      description.scripts.push(name);
    }

    const entry = { matcher: hook.matcher ?? '', hooks: [{ type: 'command', command }] };
    result[hook.event] = [...(result[hook.event] ?? []), entry];
    description.hooks.push(`${hook.event}${hook.matcher ? ` · ${hook.matcher}` : ''}`);
  }

  return result;
}

function collectMcpServers(
  selection: SandboxSelection,
  location: ClaudeLocation,
  store: AppStore,
  description: SandboxDescription,
): Record<string, unknown> {
  if (!selection.mcpIds?.length) return {};

  const result: Record<string, unknown> = {};

  for (const server of readMcpServers(location.paths.mcpConfig, store)) {
    if (!selection.mcpIds.includes(server.id)) continue;

    result[server.name] = {
      type: server.transport,
      command: server.command,
      args: server.args,
      env: server.env,
      url: server.url,
      headers: server.headers,
    };
    description.mcpServers.push(server.name);
  }

  return result;
}
