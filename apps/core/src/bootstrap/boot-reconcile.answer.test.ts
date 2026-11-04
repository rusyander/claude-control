import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';
import { afterEach, describe, expect, it } from 'vitest';
import { CREATED, deps, fakeClock, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../journal/resume.ts';
import { READ_CLASSES } from '../lib/facts/read-classes.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import type { CommandProof } from '../policy/authority/authority.ts';
import { processCommand } from '../conductor/commands.ts';
import { commandEnv } from '../conductor/commands/__fixtures__/command-env.ts';
import { readHumanLedger } from '../conductor/human/ledger.ts';
import { ACTION_READ_CLASS, type ActionFactReaders } from '../conductor/reconcile.ts';
import { createTaskRegistry, type TaskRegistry } from '../conductor/tasks.ts';
import { createBootReconcile, type BootReconcile } from './boot-reconcile.ts';

/**
 * Точка 4 сверки на языке задачи и ответ по КЛЮЧУ варианта (этап 10, F4): вопрос и варианты —
 * на языке, с которым задача запущена (нет языка — русский, как было); ответ на любом языке ведёт
 * к одному исходу: «выполнено» — `action.done`, «не выполнено» — `action.failed`, «повторить» —
 * действие снова в сверке, срок повтора — от ответа. Старый русский журнал после перезапуска ядра
 * отвечается теми же русскими словами. Путь настоящий: таймер сверки загрузки, вход команд ядра.
 */

const READ_CLASS = READ_CLASSES[ACTION_READ_CLASS.push];
const DEADLINE = 'retryUntilMs' in READ_CLASS ? READ_CLASS.retryUntilMs : 0;

const proof = async (): Promise<CommandProof> => ({
  token: 'core',
  nonce: 'valid',
  peer: 'clear',
  signature: 'absent',
});

/** Читатель факта пуша: `unknown`, пока тест не скажет, где ветка на сервере. */
function pushReaders(fact: { sha: string | null }): ActionFactReaders {
  return new Proxy({} as ActionFactReaders, {
    get: () => () => () => {
      if (fact.sha === null) throw Object.assign(new Error('EPERM: read'), { code: 'EPERM' });
      return fact.sha;
    },
  });
}

function started(task: LiveTask): string {
  const actionId = newId();
  task.append({
    kind: 'action.started',
    actor: 'core',
    data: { actionId, kind: 'push', target: 'origin/feature', idempotencyHint: '' },
  });
  return actionId;
}

async function until(probe: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const stops: (() => Promise<void>)[] = [];
const registries: TaskRegistry[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const r of registries.splice(0)) r.closeAll();
});

function stand(home = tempDir('boot-rec-answer-'), clock = fakeClock()) {
  const registry = createTaskRegistry(home, deps({ clock }));
  registries.push(registry);
  return { home, clock, registry };
}

function reconciler(s: ReturnType<typeof stand>, fact: { sha: string | null }): BootReconcile {
  return createBootReconcile({
    registry: s.registry,
    readers: pushReaders(fact),
    isAlive: async () => 'alive',
    note: () => {},
    now: () => s.clock.stamp().at,
  });
}

/** Задача с действием прежнего ядра, чья сверка дошла до вопроса человеку (точка 4). */
async function asked(lang: 'ru' | 'en' | undefined) {
  const s = stand();
  const fact = { sha: null as string | null };
  const task = await s.registry.create(lang ? { ...CREATED, lang } : CREATED);
  const actionId = started(task);
  const rec = reconciler(s, fact);
  await rec.atBoot([task.taskId]);
  s.clock.advance(DEADLINE + 1);
  stops.push(rec.start(15));
  await until(() => task.state.actions[actionId]?.status === 'awaiting-human');
  const ask = Object.values(readHumanLedger(task).asks).find((a) => a.source === 'reconcile');
  if (!ask) throw new Error('no reconcile ask');
  return { s, fact, task, actionId, rec, ask };
}

function answer(task: LiveTask, askId: string, text: string): CommandEnvelope {
  return {
    cmdId: newId(),
    kind: 'answer',
    target: { taskId: task.taskId },
    fields: { askId, answer: text },
    proof: {},
  } as CommandEnvelope;
}

describe('reconcile point 4 speaks the task language, the answer is read by key', () => {
  it('en task: English question and options; “Treat as done” closes the action as done', async () => {
    const { task, actionId, ask } = await asked('en');
    expect(ask.question).toMatch(
      /^Could not find out whether action push → origin\/feature happened: fact unknown/,
    );
    expect(ask.options).toEqual(['Check again', 'Treat as done', 'Treat as not done']);
    const out = await processCommand(
      task,
      answer(task, ask.askId, 'Treat as done'),
      proof,
      commandEnv(),
    );
    expect(out).toMatchObject({ status: 'applied', outcome: { reconcile: 'done' } });
    expect(task.state.actions[actionId]?.status).toBe('done');
  });

  it('no lang (task before stage 10): Russian question and the same Russian options as before', async () => {
    const { task, actionId, ask } = await asked(undefined);
    expect(ask.question).toMatch(
      /^Не удалось узнать, выполнено ли действие push → origin\/feature/,
    );
    expect(ask.options).toEqual([
      'повторить сверку',
      'считать выполненным',
      'считать невыполненным',
    ]);
    const out = await processCommand(
      task,
      answer(task, ask.askId, 'считать невыполненным'),
      proof,
      commandEnv(),
    );
    expect(out).toMatchObject({ status: 'applied', outcome: { reconcile: 'not-done' } });
    expect(task.state.actions[actionId]).toMatchObject({ status: 'failed', code: 'not-happened' });
  });

  it('en task, Russian label from an older panel: «считать выполненным» drives the same action as “Treat as done”', async () => {
    const { task, actionId, ask } = await asked('en');
    await processCommand(task, answer(task, ask.askId, 'считать выполненным'), proof, commandEnv());
    expect(task.state.actions[actionId]?.status).toBe('done');
  });

  it('“Check again”: the action goes back to reconcile on the boot timer, the retry clock restarts from the answer, the fact found closes it', async () => {
    const { fact, task, actionId, rec, ask } = await asked('en');
    const env = { ...commandEnv(), reconcile: () => rec };
    const out = await processCommand(task, answer(task, ask.askId, 'Check again'), proof, env);
    expect(out).toMatchObject({ status: 'applied', outcome: { reconcile: 'recheck' } });
    expect(task.state.actions[actionId]?.status).toBe('started');
    // Факт всё ещё не читается, но срок идёт от ответа: повтор, а не второй вопрос сразу.
    await until(() => rec.pending()[task.taskId]?.actions === 1);
    await new Promise((r) => setTimeout(r, 60));
    expect(Object.values(task.state.asks)).toHaveLength(1);
    expect(task.state.actions[actionId]?.status).toBe('started');
    fact.sha = 'abc123';
    await until(() => task.state.actions[actionId]?.status === 'done');
    expect(Object.values(task.state.asks)).toHaveLength(1);
  });

  it('“Check again” and the fact stays unknown past the deadline counted from the answer: a second point-4 ask', async () => {
    const { s, task, actionId, rec, ask } = await asked('en');
    const env = { ...commandEnv(), reconcile: () => rec };
    await processCommand(task, answer(task, ask.askId, 'Check again'), proof, env);
    await until(() => rec.pending()[task.taskId]?.actions === 1);
    s.clock.advance(DEADLINE + 1);
    await until(() => task.state.actions[actionId]?.status === 'awaiting-human');
    expect(Object.values(task.state.asks).map((a) => a.point)).toEqual([4, 4]);
  });

  it('an answer that is none of the options in any language is refused; the ask stays open and the action waits', async () => {
    const { task, actionId, ask } = await asked('en');
    const out = await processCommand(task, answer(task, ask.askId, 'maybe'), proof, commandEnv());
    expect(out).toMatchObject({ status: 'rejected', code: 'unknown-option' });
    expect(readHumanLedger(task).asks[ask.askId]?.state).toBe('open');
    expect(task.state.actions[actionId]?.status).toBe('awaiting-human');
  });

  it('old Russian journal, core restarted: the ask written by the old code verbatim is answered «повторить сверку» and rechecked at the next boot', async () => {
    const s = stand();
    const task = await s.registry.create(CREATED);
    const actionId = started(task);
    // Строки ровно как их писала сверка до перевода: решение `ask` и вопрос по-русски.
    const decision = task.append({
      kind: 'decision',
      actor: 'core',
      data: {
        decisionId: newId(),
        class: 'reconcile',
        inputs: [1],
        facts: [{ readClass: ACTION_READ_CLASS.push, kind: 'unknown' }],
        numbers: { elapsedMs: DEADLINE + 1 },
        reasons: ['fact unknown (EPERM) past 1 ms'],
        output: { actionId, verdict: 'ask' },
      },
    });
    const askId = newId();
    task.append({
      kind: 'human.asked',
      actor: 'core',
      cause: decision.seq,
      data: {
        askId,
        point: 4,
        source: 'reconcile',
        dedupe: actionId,
        question: `Не удалось узнать, выполнено ли действие push → origin/feature: fact unknown`,
        options: ['повторить сверку', 'считать выполненным', 'считать невыполненным'],
        defaultAction: null,
      },
    });
    const taskId = task.taskId;
    s.registry.closeAll();

    const again = stand(s.home, s.clock);
    await again.registry.openUnfinished();
    const reopened = again.registry.live(taskId);
    if (!reopened) throw new Error('task not reopened');
    expect(reopened.state.actions[actionId]?.status).toBe('awaiting-human');
    const out = await processCommand(
      reopened,
      answer(reopened, askId, 'повторить сверку'),
      proof,
      commandEnv(),
    );
    expect(out).toMatchObject({ status: 'applied', outcome: { reconcile: 'recheck' } });
    again.registry.closeAll();

    // Следующая загрузка видит действие начатым и сверяет его по факту.
    const third = stand(s.home, s.clock);
    await third.registry.openUnfinished();
    const live = third.registry.live(taskId);
    if (!live) throw new Error('task not reopened');
    await reconciler(third, { sha: 'def456' }).atBoot([taskId]);
    expect(live.state.actions[actionId]?.status).toBe('done');
  });
});
