import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';
import { afterEach, describe, expect, it } from 'vitest';
import { dlpSecretMask } from '../bootstrap/secret-mask.ts';
import { processCommand } from '../conductor/commands.ts';
import { commandEnv } from '../conductor/commands/__fixtures__/command-env.ts';
import { createTaskRegistry, type TaskRegistry } from '../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import type { CommandProof } from '../policy/authority/authority.ts';
import { refuseBeforeOpen } from './command-gate.ts';

/**
 * Суд до открытия задачи сравнивает повтор так же, как писатель журнала (ревью F-25, сторона
 * ворот): тело в журнале — после маски DLP, и без маски ядра решённый повтор с секретоподобным
 * полем на закрытой задаче получал 409 вместо сохранённого исхода.
 */

const SECRET = 'FAKE-VENDOR-a1B2c3D4e5F6g7H8i9J0k1L2';
const proof = async (): Promise<CommandProof> => ({
  token: 'core',
  nonce: 'valid',
  peer: 'clear',
  signature: 'absent',
});

const registries: TaskRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.closeAll();
});

function registryAt(dir: string): TaskRegistry {
  const registry = createTaskRegistry(dir, deps({ mask: dlpSecretMask }));
  registries.push(registry);
  return registry;
}

describe('command gate: retries judged under the journal mask', () => {
  it('F-25 an identical retry of a decided command with a masked secret on an ended task gets the stored outcome; another body is cmd-id-reused', async () => {
    const dir = tempDir('gate-mask-');
    const first = registryAt(dir);
    const task = await first.create(CREATED);
    const command: CommandEnvelope = {
      cmdId: newId(),
      kind: 'cancel',
      target: { taskId: task.taskId },
      fields: { reason: `stop ${SECRET}` },
      proof: {},
    };
    const decided = await processCommand(task, command, proof, commandEnv());
    expect(decided.code).toBeUndefined();
    if (task.state.ended === null) {
      task.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'cancelled' } });
    }
    first.closeAll();

    // Перезапуск: задача не открыта, суд идёт по свёртке с диска.
    const second = registryAt(dir);
    const retry = await refuseBeforeOpen(second, command, 'core', proof);
    expect(retry).toEqual({ result: { ...decided } });
    expect(second.live(task.taskId)).toBeUndefined();

    const other = await refuseBeforeOpen(
      second,
      { ...command, fields: { reason: `halt ${SECRET}` } },
      'core',
      proof,
    );
    expect(other && 'result' in other ? other.result.code : other).toBe('cmd-id-reused');
  });
});
