import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gooseRunFacts } from '@agentdeck/providers/goose';
import { createGooseAdapter, GOOSE_CHANNELS, GOOSE_FILES } from '../../../goose/index.ts';
import { rpcFixturePath } from '../rpc-replay.ts';
import { GOOSE_RESUME } from './resume-seeds.ts';
import type { RpcProfile } from './rpc-profile.types.ts';
import { acpMcpNames, ENDPOINT } from './shared.ts';

interface HooksFile {
  hooks?: Record<string, { hooks?: { command?: string; on_failure?: string }[] }[]>;
}

/**
 * Goose 1.54 (`goose acp`): хук ядра — плагин корня сеанса, доверия по протоколу нет. Вопрос о
 * праве Goose задаёт раньше хука (режим approve): в записи `blocked` он есть, на него ответ «да», а
 * отказ хука виден итогом вызова с ошибкой.
 */
export const GOOSE_PROFILE: RpcProfile = {
  id: gooseRunFacts.id,
  resume: GOOSE_RESUME,
  make: (options) => createGooseAdapter(options),
  command: gooseRunFacts.binary.command,
  endpoint: {
    channel: GOOSE_CHANNELS[0]!,
    endpoint: { ...ENDPOINT, dialect: 'openai-chat' },
  },
  fixtures: {
    basic: rpcFixturePath('goose', 'basic'),
    permit: rpcFixturePath('goose', 'permit'),
    blocked: rpcFixturePath('goose', 'blocked'),
  },
  hookCommand: (spec) => spec.coreHook ?? '',
  // Хук считается, только если его сбой — отказ: без `on_failure: block` Goose вызов исполняет.
  hookCommands: (dir) => {
    const file = join(dir, GOOSE_FILES.hooks);
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as HooksFile;
    return (parsed.hooks?.PreToolUse ?? []).flatMap((m) =>
      (m.hooks ?? []).filter((h) => h.on_failure === 'block').map((h) => h.command ?? ''),
    );
  },
  mcpNames: (dump) => acpMcpNames(dump.stdin),
  threadMethod: 'session/new',
  shellTool: 'shell',
  permitReply: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
  blockedShows: 'failed',
};
