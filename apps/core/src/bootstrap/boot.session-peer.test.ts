import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRegistry } from '../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../journal/resume.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { ensureCoreHome } from '../platform/core-home.ts';
import { identityOfPid } from '../platform/process-identity.ts';
import { bootCore, type BootedCore } from './boot.ts';

/**
 * Граница «человек / сессия» на настоящей загрузке (06 §Authority, ревью F-15, F-05): хост
 * «сессии» — настоящий процесс, записанный в журнал задачи своей личностью (pid + старт от ОС);
 * его ребёнок (инструмент модели) читает токен ядра и стучится в API. Таблицу процессов читает
 * само ядро — подмен нет. Ребёнок сессии не человек: ни числа страницы, ни команды.
 */

const children: ChildProcess[] = [];
let core: BootedCore | undefined;
afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await core?.stop();
  core = undefined;
});

/** Ребёнок «инструмента»: число страницы + команда с токеном ядра; печатает статусы JSON-ом. */
const TOOL = `
const input = JSON.parse(process.argv[1]);
const auth = { authorization: 'Bearer ' + input.token };
const mint = await fetch(input.url + '/v1/nonce?page=' + input.ownPage, { headers: auth });
const res = await fetch(input.url + '/v1/commands', {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify(input.body),
});
console.log(JSON.stringify({ mint: mint.status, status: res.status, body: await res.json() }));
`;

/** Хост «сессии»: ждёт строку на stdin и запускает ребёнка-инструмента, пересылая его вывод. */
const HOST = `
const { spawn } = require('node:child_process');
process.stdin.once('data', (d) => {
  const kid = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(TOOL)}, d.toString().trim()], { stdio: ['ignore', 'pipe', 'inherit'] });
  kid.stdout.pipe(process.stdout);
  kid.on('exit', () => process.exit(0));
});
setInterval(() => {}, 1000);
`;

function seedRealSession(task: LiveTask, host: { pid: number; start: string }): void {
  const unitId = newId();
  const stepId = newId();
  const sessionId = newId();
  task.append({
    kind: 'unit.created',
    actor: 'core',
    unitId,
    data: { unitId, repoKey: 'r1', branch: 'agentdeck/peer', ownedPaths: [] },
  });
  task.append({
    kind: 'step.started',
    actor: 'core',
    unitId,
    stepId,
    data: { stepId, unitId, stepKind: 'work', budgetMs: 600_000 },
  });
  task.append({
    kind: 'step.transition',
    actor: 'core',
    stepId,
    data: { stepId, event: 'start', from: 'queued', to: 'running' },
  });
  task.append({
    kind: 'session.started',
    actor: 'core',
    stepId,
    sessionId,
    data: {
      sessionId,
      stepId,
      adapter: 'claude',
      cliVersion: '1',
      route: { kind: 'stub', id: 'stub-1' },
      hops: [],
      credentialKind: 'none',
      modelAsked: 'model-a',
      modelServed: null,
      effort: null,
      hostPid: host.pid,
      hostStart: host.start,
      cliPid: null,
      cliStart: null,
      cwd: '/w',
      argv: [],
      resumeOf: null,
      cacheAgeMs: null,
    },
  });
  task.append({
    kind: 'session.transition',
    actor: 'core',
    sessionId,
    data: { sessionId, event: 'spawned', from: 'starting', to: 'live' },
  });
}

async function runTool(
  host: ChildProcess,
  input: Record<string, unknown>,
): Promise<{ mint: number; status: number; body: Record<string, unknown> }> {
  const out = new Promise<string>((resolve, reject) => {
    let text = '';
    host.stdout?.on('data', (d: Buffer) => {
      text += d.toString();
      if (text.includes('\n')) resolve(text.trim());
    });
    host.on('exit', () => resolve(text.trim()));
    host.on('error', reject);
  });
  host.stdin?.write(`${JSON.stringify(input)}\n`);
  return JSON.parse(await out) as { mint: number; status: number; body: Record<string, unknown> };
}

describe('core boot: session peers', () => {
  it('F-15 F-05 a child of a live session host is not a human: no nonce, cancel is forged-authority, the task stays draft', async () => {
    const home = join(tempDir('boot-peer-'), 'core');
    const layout = ensureCoreHome(home);
    const seed = createTaskRegistry(layout.tasks, deps());
    const created = await seed.create(CREATED);
    seed.closeAll();
    core = await bootCore({ home, build: 'peer-test' });
    const task = core.registry.live(created.taskId);
    if (!task) throw new Error('task not live');

    const host = spawn(process.execPath, ['-e', HOST], { stdio: ['pipe', 'pipe', 'inherit'] });
    children.push(host);
    const identity = await identityOfPid(host.pid ?? 0);
    if (!('value' in identity)) throw new Error('host identity unknown');
    seedRealSession(task, identity.value);

    const token = readFileSync(layout.token, 'utf8').trim();
    // Число страницы чеканит тест (он не сессия) — ребёнок сессии предъявляет годное число.
    const page = newId();
    const minted = await fetch(`${core.url}/v1/nonce?page=${page}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(minted.status).toBe(200);
    const { nonce } = (await minted.json()) as { nonce: string };
    const result = await runTool(host, {
      url: core.url,
      token,
      ownPage: newId(),
      body: {
        cmdId: newId(),
        kind: 'cancel',
        target: { taskId: task.taskId },
        fields: { reason: 'from a session child' },
        proof: { nonce, page },
      },
    });
    expect({ mint: result.mint, status: result.status, code: result.body.code }).toEqual({
      mint: 403,
      status: 403,
      code: 'forged-authority',
    });
    expect(core.registry.live(task.taskId)?.state.task).toBe('draft');
  }, 60_000);
});
