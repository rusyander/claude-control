import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexRunFacts } from '@agentdeck/providers/codex';
import {
  CODEX_CHANNELS,
  CODEX_FILES,
  codexHookCommand,
  createCodexAdapter,
} from '../../../codex/index.ts';
import { rpcFixturePath } from '../rpc-replay.ts';
import { CODEX_RESUME } from './resume-seeds.ts';
import type { RpcProfile } from './rpc-profile.types.ts';
import { ENDPOINT } from './shared.ts';

interface HooksFile {
  hooks?: Record<string, { hooks?: { command?: string }[] }[]>;
}

export const CODEX_PROFILE: RpcProfile = {
  id: codexRunFacts.id,
  resume: CODEX_RESUME,
  make: (options) => createCodexAdapter(options),
  command: codexRunFacts.binary.command,
  endpoint: {
    channel: CODEX_CHANNELS[0]!,
    endpoint: { ...ENDPOINT, dialect: 'openai-responses' },
  },
  fixtures: {
    basic: rpcFixturePath('codex', 'basic'),
    permit: rpcFixturePath('codex', 'permit'),
    blocked: rpcFixturePath('codex', 'blocked'),
  },
  hookCommand: (spec) => codexHookCommand(spec) ?? '',
  hookCommands: (dir) => {
    const file = join(dir, CODEX_FILES.hooks);
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as HooksFile;
    return (parsed.hooks?.PreToolUse ?? []).flatMap((m) =>
      (m.hooks ?? []).map((h) => h.command ?? ''),
    );
  },
  // Таблицы `[mcp_servers."<имя>"]` config.toml дома сеанса.
  mcpNames: (_dump, dir) => {
    const file = join(dir, CODEX_FILES.config);
    if (!existsSync(file)) return [];
    return [...readFileSync(file, 'utf8').matchAll(/^\[mcp_servers\.(".*")\]$/gm)].map(
      (m) => JSON.parse(m[1]!) as string,
    );
  },
  trustMethod: 'config/batchWrite',
  threadMethod: 'thread/start',
  shellTool: 'Bash',
  permitReply: { decision: 'accept' },
  blockedShows: 'nothing',
};
