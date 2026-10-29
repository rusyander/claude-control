import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootCore, type BootedCore } from '../bootstrap/boot.ts';
import { createTaskRegistry } from '../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { ensureCoreHome } from '../platform/core-home.ts';

/**
 * Полномочия команды судятся ДО того, как задача открывается (ревью F-47, verify-api V2/V3), на
 * настоящей загрузке и настоящем перезапуске: токен сессии не возобновляет чужую или законченную
 * задачу, а чужое тело с тем же `cmdId` не закрывает принятую до краха команду человека.
 */

let core: BootedCore | undefined;
afterEach(async () => {
  await core?.stop();
  core = undefined;
});

const lines = (dir: string, taskId: string) => readJournalLines(dir, taskId).lines;

async function post(url: string, bearer: string, body: unknown) {
  const res = await fetch(`${url}/v1/commands`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function seeded(prepare?: (task: Awaited<ReturnType<typeof seedTask>>) => void) {
  const home = join(tempDir('cmd-auth-'), 'core');
  const layout = ensureCoreHome(home);
  const task = await seedTask(layout.tasks);
  prepare?.(task);
  task.close();
  return { home, layout, taskId: task.taskId, dir: task.dir };
}

async function seedTask(tasksDir: string) {
  const seed = createTaskRegistry(tasksDir, deps());
  return seed.create(CREATED);
}

describe('POST /v1/commands: authority before the task opens', () => {
  it('F-47 V2 a session token and a proofless core token on an ENDED task after restart: 409, the journal is untouched, the task stays closed', async () => {
    const s = await seeded((task) => {
      task.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'cancelled' } });
    });
    core = await bootCore({ home: s.home, build: 'cmd-auth' });
    expect(core.registry.live(s.taskId)).toBeUndefined();
    const before = lines(s.dir, s.taskId).length;
    const sessionToken = core.sessionTokens.mint({ taskId: s.taskId, sessionId: newId() });
    const coreToken = readFileSync(s.layout.token, 'utf8').trim();
    const envelope = { kind: 'pause', target: { taskId: s.taskId }, fields: {}, proof: {} };
    for (const bearer of [sessionToken, sessionToken, coreToken]) {
      const res = await post(core.url, bearer, { ...envelope, cmdId: newId() });
      expect(res.status).toBe(409);
    }
    expect(lines(s.dir, s.taskId).length).toBe(before);
    expect(core.registry.live(s.taskId)).toBeUndefined();
  }, 60_000);

  it('F-47 a session token on an unfinished task this core does not hold: 403 forged-authority without opening it', async () => {
    const s = await seeded();
    core = await bootCore({ home: s.home, build: 'cmd-auth' });
    core.registry.drop(s.taskId);
    const before = lines(s.dir, s.taskId).length;
    const sessionToken = core.sessionTokens.mint({ taskId: s.taskId, sessionId: newId() });
    const res = await post(core.url, sessionToken, {
      cmdId: newId(),
      kind: 'cancel',
      target: { taskId: s.taskId },
      fields: { reason: 'session' },
      proof: {},
    });
    expect({ status: res.status, code: res.body.code }).toEqual({
      status: 403,
      code: 'forged-authority',
    });
    expect(lines(s.dir, s.taskId).length).toBe(before);
    expect(core.registry.live(s.taskId)).toBeUndefined();
  }, 60_000);

  it('F-47 V3 a session token reusing a crash-pending cmdId with another body is refused WITHOUT closing it; the original retry applies', async () => {
    const cmdId = newId();
    const original = (taskId: string) => ({
      cmdId,
      kind: 'cancel',
      target: { taskId },
      fields: { reason: 'human cancel' },
      proof: {},
    });
    const s = await seeded((task) => {
      task.append({
        kind: 'command.received',
        actor: 'human:panel',
        cmdId,
        data: {
          kind: 'cancel',
          target: { taskId: task.taskId },
          expectSeq: null,
          fields: { reason: 'human cancel' },
          proof: { token: 'core', nonce: 'valid', peer: 'clear', signature: 'absent' },
        },
      });
    });
    core = await bootCore({ home: s.home, build: 'cmd-auth' });
    expect(core.registry.live(s.taskId)?.state.commands[cmdId]?.status).toBe('received');
    const before = lines(s.dir, s.taskId).length;
    const sessionToken = core.sessionTokens.mint({ taskId: s.taskId, sessionId: newId() });
    const attack = await post(core.url, sessionToken, {
      ...original(s.taskId),
      fields: { reason: 'other' },
    });
    expect(attack.status).toBe(409);
    expect(lines(s.dir, s.taskId).length).toBe(before);
    expect(core.registry.live(s.taskId)?.state.commands[cmdId]?.status).toBe('received');
    const coreToken = readFileSync(s.layout.token, 'utf8').trim();
    const retry = await post(core.url, coreToken, original(s.taskId));
    expect({ status: retry.status, to: (retry.body.outcome as { to?: string })?.to }).toEqual({
      status: 200,
      to: 'cancelled',
    });
  }, 60_000);
});
