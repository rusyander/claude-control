import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';
import { describe, expect, it } from 'vitest';
import { dlpSecretMask } from '../bootstrap/secret-mask.ts';
import { deps, openFresh, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { resume } from '../journal/resume.ts';
import type { CommandProof } from '../policy/authority/authority.ts';
import { knownOutcome, processCommand } from './commands.ts';
import { commandEnv } from './commands/__fixtures__/command-env.ts';

/**
 * Ревью core-s2 F-25: журнал хранит тело команды ПОСЛЕ маски DLP, свёртка считала отпечаток по
 * маскированному телу, а повтор сравнивался по сырому — тот же самый повтор с секретоподобным
 * полем отвергался `cmd-id-reused`. Маска — настоящая маска ядра (`dlpSecretMask`).
 */
const SECRET = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const CMD_ID = '0199c82c-c000-7006-8b11-c69727c63094';
const proof = async (): Promise<CommandProof> => ({
  token: 'core',
  nonce: 'valid',
  peer: 'clear',
  signature: 'absent',
});

function envelope(taskId: string, reason: string): CommandEnvelope {
  return { cmdId: CMD_ID, kind: 'cancel', target: { taskId }, fields: { reason }, proof: {} };
}

describe('core-s2 command retry under the DLP mask', () => {
  it('F-25 an identical retry of a command with a masked secret gets the stored outcome, not cmd-id-reused', async () => {
    const { task, taskId } = await openFresh(tempDir('mr-'), deps({ mask: dlpSecretMask }));
    const command = envelope(taskId, `stop ${SECRET}`);
    const first = await processCommand(task, command, proof, commandEnv());
    expect(first.code).not.toBe('cmd-id-reused');
    const second = await processCommand(task, command, proof, commandEnv());
    expect(second.code).not.toBe('cmd-id-reused');
    expect({ status: second.status, seq: second.seq }).toEqual({
      status: first.status,
      seq: first.seq,
    });
    // Контроль: другое тело под тем же cmdId по-прежнему отказ.
    const other = await processCommand(
      task,
      envelope(taskId, `halt ${SECRET}`),
      proof,
      commandEnv(),
    );
    expect(other.code).toBe('cmd-id-reused');
    task.close();
  });

  it('F-25 after a reopen (fold from the masked journal) the identical retry still matches', async () => {
    const { task, taskId, dir } = await openFresh(tempDir('mr-'), deps({ mask: dlpSecretMask }));
    const command = envelope(taskId, `stop ${SECRET}`);
    const first = await processCommand(task, command, proof, commandEnv());
    task.close();
    const reopened = await resume(dir, taskId, deps({ mask: dlpSecretMask }));
    if (!reopened.ok) throw new Error(reopened.reason);
    const again = await processCommand(reopened.task, command, proof, commandEnv());
    expect(again.code).not.toBe('cmd-id-reused');
    expect(again.status).toBe(first.status);
    // Закрытая задача без маски под рукой (суд до открытия): маскированную запись не
    // объявляет чужой — решит живая задача с маской.
    expect(knownOutcome(reopened.task.state, command)).toBeUndefined();
    expect(knownOutcome(reopened.task.state, command, dlpSecretMask)?.status).toBe(first.status);
    reopened.task.close();
  });
});
