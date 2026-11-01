import { join } from 'node:path';
import type { CommandEnvelope, CommandKind } from '@agentdeck/contracts/core/commands';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { CREATED, openFresh, tempDir } from '../../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../../journal/resume.ts';
import { newId } from '../../../lib/ids/uuidv7.ts';
import { layoutOf } from '../../../platform/core-home.ts';
import type { CommandProof } from '../../../policy/authority/authority.ts';
import type { CommandEnv } from '../../commands.ts';
import { commandEnv } from '../../commands/__fixtures__/command-env.ts';
import { presetOf } from '../presets.ts';

/** Помощники тестов зоны сценария: задача в доме ядра (библиотека рядом), команды с доказательством. */

export const HUMAN_PROOF = async (): Promise<CommandProof> => ({
  token: 'core',
  nonce: 'valid',
  peer: 'clear',
  signature: 'absent',
});

export type AllowedRoute = JournalDataV1['task.created']['allowedRoutes'][number];

export const LOGIN: AllowedRoute = {
  adapter: 'claude',
  route: { kind: 'cli-login', id: 'cli-login-claude' },
  modelPattern: 'claude-*',
};
export const API_KEY: AllowedRoute = {
  adapter: 'claude',
  route: { kind: 'api-key', id: 'anthropic-key' },
  modelPattern: 'claude-*',
};
export const QWEN: AllowedRoute = {
  adapter: 'qwen',
  route: { kind: 'local', id: 'local-own' },
  modelPattern: 'qwen3-coder',
};

/**
 * Задача в `<дом>/tasks/<id>`: библиотека её дома — `<дом>/scenarios`; `env` — среда команды над
 * тем же домом, как её дал бы API ядра.
 */
export async function homeTask(
  created: Partial<JournalDataV1['task.created']> = {},
): Promise<{ task: LiveTask; home: string; libraryDir: string; env: CommandEnv }> {
  const home = tempDir('scn-');
  const { task } = await openFresh(join(home, 'tasks'));
  task.append({
    kind: 'task.created',
    actor: 'core',
    data: { ...CREATED, scenario: { id: 'feature', version: 1 }, ...created },
  });
  return { task, home, libraryDir: layoutOf(home).scenarios, env: commandEnv({ home }) };
}

export function envelope(
  task: LiveTask,
  kind: CommandKind,
  fields: Record<string, unknown>,
  cmdId: string = newId(),
): CommandEnvelope {
  return { cmdId, kind, target: { taskId: task.taskId }, fields: fields as never, proof: {} };
}

/** Пресет `feature@1` под своим id и версией — правка, которую человек сохраняет. */
export function forkOfFeature(
  id: string,
  version: number,
  edit?: (s: Scenario) => Scenario,
): Scenario {
  const base = presetOf({ id: 'feature', version: 1 }) as Scenario;
  const forked: Scenario = { ...base, id, version, title: `${base.title} (правка)` };
  return edit ? edit(forked) : forked;
}
