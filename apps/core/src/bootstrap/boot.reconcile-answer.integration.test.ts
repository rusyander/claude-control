import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readHumanLedger } from '../conductor/human/ledger.ts';
import { ACTION_READ_CLASS, type ActionFactReaders } from '../conductor/reconcile.ts';
import { createTaskRegistry } from '../conductor/tasks.ts';
import { CREATED, deps, fakeClock, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { READ_CLASSES } from '../lib/facts/read-classes.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { layoutOf } from '../platform/core-home.ts';
import { bootCore, type BootedCore } from './boot.ts';

/**
 * Ответ «Check again» на вопрос сверки (точка 4) на НАСТОЯЩЕЙ загрузке ядра (этап 10, F4): вход
 * `/v1/commands` → команда `answer` → `settleReconcileAnswer` → порт `reconcile()` среды команд,
 * который проводит `boot-core.ts`, → таймер сверки ЭТОЙ загрузки читает факт снова и закрывает
 * действие. Без проводки действие ждало бы следующей загрузки ядра: таймер держит только
 * действия с исходом `retry`, а вопрос его снял. Подменён только читатель факта (внешний мир:
 * сервер git) — всё между ручкой API и журналом настоящее; CLI не запускается.
 */

const READ_CLASS = READ_CLASSES[ACTION_READ_CLASS.push];
const DEADLINE = 'retryUntilMs' in READ_CLASS ? READ_CLASS.retryUntilMs : 0;

const cores: BootedCore[] = [];
afterAll(async () => {
  for (const core of cores) await core.stop().catch(() => undefined);
});

/** Факт пуша: `unknown` (чтение не вышло), пока тест не скажет, где ветка на сервере. */
function pushReaders(fact: { sha: string | null }): ActionFactReaders {
  return new Proxy({} as ActionFactReaders, {
    get: () => () => () => {
      if (fact.sha === null) throw Object.assign(new Error('EPERM: read'), { code: 'EPERM' });
      return fact.sha;
    },
  });
}

/**
 * Дом ядра с задачей прежнего ядра: начатый пуш и первая сверка, записанная давно (срок повтора
 * истёк) — новая загрузка сразу спрашивает человека.
 */
async function seededHome(): Promise<{ home: string; taskId: string; actionId: string }> {
  const home = join(tempDir('boot-rec-answer-'), 'core');
  const registry = createTaskRegistry(
    layoutOf(home).tasks,
    deps({ clock: fakeClock(Date.now() - DEADLINE - 60_000) }),
  );
  const task = await registry.create({ ...CREATED, lang: 'en' });
  const actionId = newId();
  const startedLine = task.append({
    kind: 'action.started',
    actor: 'core',
    data: { actionId, kind: 'push', target: 'origin/feature', idempotencyHint: '' },
  });
  task.append({
    kind: 'decision',
    actor: 'core',
    cause: startedLine.seq,
    data: {
      decisionId: newId(),
      class: 'reconcile',
      inputs: [startedLine.seq],
      facts: [{ readClass: ACTION_READ_CLASS.push, kind: 'unknown' }],
      numbers: { elapsedMs: 0 },
      reasons: ['prior core: fact unread'],
      output: { actionId, verdict: 'retry' },
    },
  });
  registry.closeAll();
  return { home, taskId: task.taskId, actionId };
}

async function until(probe: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function answer(core: BootedCore, taskId: string, askId: string, text: string) {
  const token = readFileSync(core.layout.token, 'utf8').trim();
  const auth = { authorization: `Bearer ${token}` };
  const page = newId();
  const minted = await fetch(`${core.url}/v1/nonce?page=${page}`, { headers: auth });
  const { nonce } = (await minted.json()) as { nonce: string };
  const res = await fetch(`${core.url}/v1/commands`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      cmdId: newId(),
      kind: 'answer',
      target: { taskId },
      fields: { askId, answer: text },
      proof: { nonce, page },
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('reconcile answer through the real boot wiring', () => {
  it('«Check again» via /v1/commands: this boot rechecks the action at once and the fact found closes it', async () => {
    const seeded = await seededHome();
    const fact = { sha: null as string | null };
    const core = await bootCore({
      home: seeded.home,
      build: 'reconcile-answer-test',
      panelAppData: null,
      loop: false,
      readers: pushReaders(fact),
      reconcileEveryMs: 25,
    });
    cores.push(core);
    const task = core.registry.live(seeded.taskId);
    if (!task) throw new Error('seeded task not opened by the boot');
    await until(
      () => task.state.actions[seeded.actionId]?.status === 'awaiting-human',
      'point 4 asked at boot',
    );
    const ask = Object.values(readHumanLedger(task).asks).find((a) => a.source === 'reconcile');
    expect(ask?.question).toMatch(/^Could not find out whether action push → origin\/feature/);
    expect(ask?.options).toContain('Check again');

    fact.sha = 'abc1234';
    const reply = await answer(core, task.taskId, ask!.askId, 'Check again');
    expect(reply.status).toBe(200);
    await until(
      () => task.state.actions[seeded.actionId]?.status === 'done',
      'action closed by the recheck of this boot',
      3_000,
    );
  });
});
