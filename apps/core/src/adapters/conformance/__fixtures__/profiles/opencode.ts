import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { opencodeRunFacts } from '@agentdeck/providers/opencode';
import {
  createOpencodeAdapter,
  OPENCODE_CHANNELS,
  OPENCODE_FILES,
} from '../../../opencode/index.ts';
import { HOOK_JSON_FLAG } from '../../../hook-words.ts';
import { rpcFixturePath } from '../rpc-replay.ts';
import type { RpcProfile } from './rpc-profile.types.ts';
import { ENDPOINT } from './shared.ts';

/**
 * OpenCode 1.18 (`opencode acp`): хук ядра — плагин сеанса (`tool.execute.before`), конфиг сеанса
 * его подключает; доверия по протоколу нет. Хук идёт раньше вопроса о праве: отказ — без вопроса,
 * итог вызова ошибкой с текстом отказа (его видит модель).
 */
export const OPENCODE_PROFILE: RpcProfile = {
  id: opencodeRunFacts.id,
  make: (options) => createOpencodeAdapter(options),
  command: opencodeRunFacts.binary.command,
  endpoint: {
    channel: OPENCODE_CHANNELS[0]!,
    endpoint: { ...ENDPOINT, dialect: 'openai-chat' },
  },
  fixtures: {
    basic: rpcFixturePath('opencode', 'basic'),
    permit: rpcFixturePath('opencode', 'permit'),
    blocked: rpcFixturePath('opencode', 'blocked'),
  },
  hookCommand: (spec) => `${spec.coreHook ?? ''} ${HOOK_JSON_FLAG}`,
  // Команда плагина считается, только если конфиг сеанса этот плагин подключает.
  hookCommands: (dir) => {
    const config = join(dir, OPENCODE_FILES.config);
    const plugin = join(dir, OPENCODE_FILES.plugin);
    if (!existsSync(config) || !existsSync(plugin)) return [];
    const parsed = JSON.parse(readFileSync(config, 'utf8')) as { plugin?: string[] };
    if (!parsed.plugin?.includes(pathToFileURL(plugin).href)) return [];
    const line = /^const COMMAND = (".*");$/m.exec(readFileSync(plugin, 'utf8'));
    return line ? [JSON.parse(line[1]!) as string] : [];
  },
  // Ключ `mcp` конфига сеанса — только если CLI этот конфиг читает (`OPENCODE_CONFIG`).
  mcpNames: (dump, dir) => {
    const config = join(dir, OPENCODE_FILES.config);
    if (!existsSync(config) || dump.env.OPENCODE_CONFIG !== config) return [];
    const parsed = JSON.parse(readFileSync(config, 'utf8')) as { mcp?: Record<string, unknown> };
    return Object.keys(parsed.mcp ?? {});
  },
  threadMethod: 'session/new',
  shellTool: 'bash',
  permitReply: { outcome: { outcome: 'selected', optionId: 'once' } },
  blockedShows: 'failed',
};
