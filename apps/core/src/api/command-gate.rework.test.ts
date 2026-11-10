import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';
import { afterEach, describe, expect, it } from 'vitest';
import { seedSession } from '../conductor/model-tools/__fixtures__/seed.ts';
import type { ReworkPort } from '../conductor/takeover/takeover.types.ts';
import { createTaskRegistry, type TaskRegistry } from '../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import type { CommandProof } from '../policy/authority/authority.ts';
import { refuseBeforeOpen } from './command-gate.ts';

/**
 * Доработка законченной задачи до её открытия (этап 12, P162): законченную задачу ядро не
 * возобновляет и строк после её `task.ended` не пишет, поэтому `rework` решается в воротах API —
 * носитель через порт, повтор того же `cmdId` — по ключу оценки носителя, до суда полномочий.
 */

const good = async (): Promise<CommandProof> => ({
  token: 'core',
  nonce: 'valid',
  peer: 'clear',
  signature: 'absent',
});
const burnt = async (): Promise<CommandProof> => ({
  token: 'core',
  nonce: 'invalid',
  peer: 'clear',
  signature: 'absent',
});

const registries: TaskRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.closeAll();
});

function registryAt(dir: string): TaskRegistry {
  const registry = createTaskRegistry(dir, deps());
  registries.push(registry);
  return registry;
}

async function endedTask(withMr: boolean): Promise<{ dir: string; taskId: string }> {
  const dir = tempDir('gate-rework-');
  const first = registryAt(dir);
  const task = await first.create(CREATED);
  const { unitId } = seedSession(task, { stepKind: 'work' });
  if (withMr)
    task.append({
      kind: 'publish.mr',
      actor: 'core',
      unitId,
      data: {
        unitId,
        forge: 'gitlab',
        mrId: '1',
        mrIid: 4,
        url: 'https://forge.example.com/g/p/-/merge_requests/4',
        sourceBranch: 'agentdeck/x',
        actionId: newId(),
      },
    });
  task.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });
  first.closeAll();
  return { dir, taskId: task.taskId };
}

function rework(taskId: string, text = 'rename it'): CommandEnvelope {
  return { cmdId: newId(), kind: 'rework', target: { taskId }, fields: { text }, proof: {} };
}

function portLog() {
  const calls: { taskId: string; cmdId: string; note: string }[] = [];
  const port: ReworkPort = {
    async carrier(source, cmdId, note) {
      calls.push({ taskId: source.taskId, cmdId, note });
      return { ok: true, carrierTaskId: 'carrier-1' };
    },
  };
  return { calls, port };
}

describe('command gate: rework of an ended task (P162)', () => {
  it('done with an open MR → the port opens a carrier, the source journal gets no line; no port wired → 409 task-ended as before', async () => {
    const { dir, taskId } = await endedTask(true);
    const registry = registryAt(dir);
    const before = readJournalLines(`${dir}/${taskId}`, taskId).lines.length;
    const { calls, port } = portLog();
    const c = rework(taskId);
    const got = await refuseBeforeOpen(registry, c, 'core', good, () => port);
    expect(got).toMatchObject({
      result: { cmdId: c.cmdId, status: 'applied', outcome: { carrierTaskId: 'carrier-1' } },
    });
    expect(calls).toEqual([{ taskId, cmdId: c.cmdId, note: 'rename it' }]);
    expect(readJournalLines(`${dir}/${taskId}`, taskId).lines.length).toBe(before);
    expect(registry.live(taskId)).toBeUndefined();
    const unwired = await refuseBeforeOpen(registry, rework(taskId), 'core', good);
    expect(unwired).toMatchObject({ status: 409, error: { code: 'task-ended' } });
  });

  it('a session token and a burnt nonce are refused before the port; done without an MR → state-conflict', async () => {
    const { dir, taskId } = await endedTask(true);
    const registry = registryAt(dir);
    const { calls, port } = portLog();
    expect(
      await refuseBeforeOpen(registry, rework(taskId), 'session', good, () => port),
    ).toMatchObject({ result: { status: 'rejected', code: 'forged-authority' } });
    expect(
      await refuseBeforeOpen(registry, rework(taskId), 'core', burnt, () => port),
    ).toMatchObject({
      result: { status: 'rejected', code: 'nonce-invalid' },
    });
    expect(calls).toEqual([]);
    const plain = await endedTask(false);
    const other = registryAt(plain.dir);
    const noMr = await refuseBeforeOpen(other, rework(plain.taskId), 'core', good, () => port);
    expect(noMr).toMatchObject({ result: { status: 'rejected', code: 'state-conflict' } });
  });

  it('a retry of the same cmdId answers with the carrier already made — before the proof (its nonce burnt on the first call)', async () => {
    const { dir, taskId } = await endedTask(true);
    const registry = registryAt(dir);
    const c = rework(taskId);
    // Носитель первого звонка: задача с ключом оценки = `cmdId` доработки.
    const carrier = await registry.create({ ...CREATED, origin: { cmdId: c.cmdId } });
    const { calls, port } = portLog();
    const retry = await refuseBeforeOpen(registry, c, 'core', burnt, () => port);
    expect(retry).toMatchObject({
      result: { status: 'applied', outcome: { carrierTaskId: carrier.taskId } },
    });
    expect(calls).toEqual([]);
  });
});
