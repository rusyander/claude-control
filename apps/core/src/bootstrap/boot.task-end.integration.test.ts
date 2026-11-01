import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { estimateBody, gitRepo } from '../conductor/split/__fixtures__/split-stand.ts';
import { CREATED, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { bootCore, type BootedCore, type BootOptions } from './boot.ts';

/**
 * Конец задачи без исполнителя — тем же путём, что у исполнителя (00 §Words: итоговый отчёт —
 * сообщение конца задачи), на НАСТОЯЩЕЙ загрузке, через ручки API: отмена черновика (исполнителя
 * у него не бывает), отказ оценки (задача кончается в самом создании) и крах ядра сразу после
 * конца командой — следующая загрузка дописывает отчёт ровно раз, сколько бы раз ядро ни
 * перезапускалось. CLI не запускается ни одной задачей: дом ядра и HOME сессий — одноразовые.
 */

const cores: BootedCore[] = [];
afterAll(async () => {
  for (const core of cores) await core.stop().catch(() => undefined);
});

function options(home: string, loop: boolean): BootOptions {
  const sessionHome = tempDir('task-end-home-');
  return {
    home,
    build: 'task-end-test',
    panelAppData: null,
    loop: loop
      ? {
          pin: () => ({ HOME: sessionHome, USERPROFILE: sessionHome, PATH: '' }),
          sweepMs: 50,
        }
      : false,
  };
}

async function boot(home: string, loop = true): Promise<BootedCore> {
  const core = await bootCore(options(home, loop));
  cores.push(core);
  return core;
}

async function stop(core: BootedCore): Promise<void> {
  cores.splice(cores.indexOf(core), 1);
  await core.stop();
}

async function proofOf(core: BootedCore): Promise<{ auth: Record<string, string>; proof: object }> {
  const token = readFileSync(core.layout.token, 'utf8').trim();
  const auth = { authorization: `Bearer ${token}` };
  const page = newId();
  const minted = await fetch(`${core.url}/v1/nonce?page=${page}`, { headers: auth });
  const { nonce } = (await minted.json()) as { nonce: string };
  return { auth, proof: { nonce, page } };
}

async function cancel(core: BootedCore, taskId: string): Promise<number> {
  const { auth, proof } = await proofOf(core);
  const res = await fetch(`${core.url}/v1/commands`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      cmdId: newId(),
      kind: 'cancel',
      target: { taskId },
      fields: { reason: 'передумал' },
      proof,
    }),
  });
  return res.status;
}

function linesOf(core: BootedCore, taskId: string): JournalLine[] {
  return readJournalLines(join(core.layout.tasks, taskId), taskId).lines as JournalLine[];
}

const reportsOf = (core: BootedCore, taskId: string) =>
  linesOf(core, taskId).filter((l) => l.kind === 'report.final');

function reportBody(core: BootedCore, taskId: string): { outcome: string } {
  const line = reportsOf(core, taskId)[0] as JournalLine<'report.final'>;
  const file = join(core.layout.tasks, taskId, 'artifacts', `${line.data.report.sha256}.json`);
  return JSON.parse(readFileSync(file, 'utf8')) as { outcome: string };
}

async function until(probe: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Достаточно обходов исполнителя, чтобы второй отчёт успел бы лечь, если бы ложился. */
const settle = () => new Promise((r) => setTimeout(r, 400));

describe('a task ended without a runner gets the same end as one ended by its runner', () => {
  it('cancel of a draft through /v1/commands: report.final «cancelled» once, task-end cleanup decided', async () => {
    const core = await boot(join(tempDir('task-end-draft-'), 'core'));
    const task = await core.registry.create(CREATED);
    // Свой временный каталог задачи со сроком «конец задачи»: уборка конца его снимает.
    const scratch = tempDir('task-end-scratch-');
    const rid = newId();
    task.append({
      kind: 'resource.created',
      actor: 'core',
      data: { rid, kind: 'tmpdir', owner: 'core', release: 'task-end', ref: scratch },
    });
    expect(await cancel(core, task.taskId)).toBe(200);
    await until(() => reportsOf(core, task.taskId).length === 1, 'report of the cancelled draft');
    expect(reportsOf(core, task.taskId)[0]!.data).toMatchObject({ at: 'ended' });
    expect(reportBody(core, task.taskId).outcome).toBe('cancelled');
    const cleanup = linesOf(core, task.taskId).find(
      (l) => l.kind === 'decision' && (l.data as { class?: string }).class === 'cleanup',
    );
    expect((cleanup?.data as { reasons?: string[] } | undefined)?.reasons?.[0]).toMatch(rid);
    expect(existsSync(scratch)).toBe(false);
    await settle();
    expect(reportsOf(core, task.taskId)).toHaveLength(1);
    await stop(core);
  });

  it('estimate refused at creation (scenario not in the library): the failed task carries report.final «failed»', async () => {
    const core = await boot(join(tempDir('task-end-refused-'), 'core'));
    const repo = gitRepo(tempDir('task-end-repo-'), 'repo', { 'README.md': '# r\n' });
    const { auth, proof } = await proofOf(core);
    const body = {
      ...estimateBody([repo], { scenario: { id: 'no-such-scenario', version: 1 } }),
      proof,
    };
    const res = await fetch(`${core.url}/v1/estimate`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);
    const { taskId } = (await res.json()) as { taskId: string };
    expect(core.registry.live(taskId)?.state.ended).toBe('failed');
    await until(() => reportsOf(core, taskId).length === 1, 'report of the refused estimate');
    expect(reportBody(core, taskId).outcome).toBe('failed');
    await stop(core);
  });

  it('core gone right after a command ended the task: the next boot writes the report once, later boots add none', async () => {
    const home = join(tempDir('task-end-crash-'), 'core');
    // Ядро без исполнителя — тот же журнал, что у краха между концом командой и закрытием.
    const first = await boot(home, false);
    const task = await first.registry.create(CREATED);
    const taskId = task.taskId;
    expect(await cancel(first, taskId)).toBe(200);
    expect(first.registry.live(taskId)?.state.ended).toBe('cancelled');
    expect(reportsOf(first, taskId)).toHaveLength(0);
    await stop(first);

    const second = await boot(home);
    await until(() => reportsOf(second, taskId).length === 1, 'report after the restart');
    expect(reportBody(second, taskId).outcome).toBe('cancelled');
    await settle();
    await stop(second);

    const third = await boot(home);
    await settle();
    expect(reportsOf(third, taskId)).toHaveLength(1);
    // Закрытая задача больше не открывается на запись: аренды у ядра на неё нет.
    expect(third.registry.live(taskId)).toBeUndefined();
    await stop(third);
  }, 60_000);
});
