import type { CommandEnvelope, CommandKind } from '@agentdeck/contracts/core/commands';
import { describe, expect, it } from 'vitest';
import { CREATED, deps, fakeClock, openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { CommandProof } from '../../policy/authority/authority.ts';
import { processCommand } from '../commands.ts';
import { commandEnv } from '../commands/__fixtures__/command-env.ts';
import { seedSession, SEED_HUMAN_POLICY } from '../model-tools/__fixtures__/seed.ts';
import { pendingDeliveries, recordDelivery } from './deliver.ts';
import type { RaiseInput } from './human.types.ts';
import { readHumanLedger } from './ledger.ts';
import { raiseHumanPoint } from './raise.ts';
import { applyAskUpkeep, decideAskUpkeep, NONBLOCKING_EXPIRE_MS } from './upkeep.ts';

/**
 * Вмешательства человека через вход команд ядра (`processCommand`): ответ (P71 — в срок отпускает
 * шаг, поздний хранится и доставляется, если шаг жив), сообщение шагу (доставка ровно раз, F26),
 * грант (только проект задачи).
 */

const proof = async (): Promise<CommandProof> => ({
  token: 'core',
  nonce: 'valid',
  peer: 'clear',
  signature: 'absent',
});

function cmd(taskId: string, kind: CommandKind, fields: CommandEnvelope['fields']) {
  return { cmdId: newId(), kind, target: { taskId }, fields, proof: {} } as CommandEnvelope;
}

const policy = { policy: SEED_HUMAN_POLICY };

function raise(task: LiveTask, stepId: string, over: Partial<RaiseInput> = {}): string {
  const out = raiseHumanPoint(
    task,
    {
      source: 'round-cap',
      stepId,
      sessionId: null,
      action: null,
      point: 6,
      dedupe: newId(),
      question: 'one more round?',
      options: ['yes', 'no'],
      recommendation: 'no',
      blocking: true,
      ...over,
    },
    policy,
  );
  if (out.kind !== 'asked') throw new Error(out.kind);
  return out.askId;
}

async function setup() {
  const clock = fakeClock();
  const { task, taskId } = await openFresh(undefined, deps({ clock }));
  task.append({ kind: 'task.created', actor: 'core', data: CREATED });
  const s = seedSession(task, { stepKind: 'work' });
  return { task, taskId, clock, ...s };
}

/** Конец шага, как его пишет ядро: переход машины, затем исход. */
function failStep(task: LiveTask, stepId: string): void {
  const from = task.state.steps[stepId]!.state;
  task.append({
    kind: 'step.transition',
    actor: 'core',
    stepId,
    data: { stepId, event: 'fail', from, to: 'failed' },
  });
  task.append({
    kind: 'step.ended',
    actor: 'core',
    stepId,
    data: { stepId, outcome: 'failed', basis: 'core', reason: 'stopped' },
  });
}

const kinds = (task: LiveTask) => readJournalLines(task.dir, task.taskId).lines.map((l) => l.kind);

describe('answer, late answer, message, grant', () => {
  it('P71 an answer to an open blocking ask resumes the step once; a second answer and an unknown ask are refused', async () => {
    const s = await setup();
    const askId = raise(s.task, s.stepId);
    expect(s.task.state.steps[s.stepId]?.state).toBe('waiting-human');
    const out = await processCommand(
      s.task,
      cmd(s.taskId, 'answer', { askId, answer: 'yes' }),
      proof,
      commandEnv(),
    );
    expect(out).toMatchObject({ status: 'applied', outcome: { late: 'false', resumed: 'true' } });
    expect(s.task.state.steps[s.stepId]?.state).toBe('running');
    const ask = readHumanLedger(s.task).asks[askId];
    expect(ask).toMatchObject({
      state: 'answered',
      answers: [{ text: 'yes', late: false, channel: 'panel' }],
    });
    const again = await processCommand(
      s.task,
      cmd(s.taskId, 'answer', { askId, answer: 'no' }),
      proof,
      commandEnv(),
    );
    expect(again).toMatchObject({ status: 'rejected', code: 'already-answered' });
    const unknown = await processCommand(
      s.task,
      cmd(s.taskId, 'answer', { askId: newId(), answer: 'x' }),
      proof,
      commandEnv(),
    );
    expect(unknown).toMatchObject({ status: 'rejected', code: 'unknown-ask' });
    expect(kinds(s.task).filter((k) => k === 'human.answered')).toHaveLength(1);
    s.task.close();
  });

  it('P71 a step with two open blocking asks keeps waiting until both are answered', async () => {
    const s = await setup();
    const a = raise(s.task, s.stepId);
    const b = raise(s.task, s.stepId, { question: 'second?' });
    await processCommand(
      s.task,
      cmd(s.taskId, 'answer', { askId: a, answer: 'yes' }),
      proof,
      commandEnv(),
    );
    expect(s.task.state.steps[s.stepId]?.state).toBe('waiting-human');
    await processCommand(
      s.task,
      cmd(s.taskId, 'answer', { askId: b, answer: 'yes' }),
      proof,
      commandEnv(),
    );
    expect(s.task.state.steps[s.stepId]?.state).toBe('running');
    s.task.close();
  });

  it('P71 a late answer to an expired ask is stored, never resumes, and is delivered once to the live step', async () => {
    const s = await setup();
    const askId = raise(s.task, s.stepId, { blocking: false, source: 'scenario-step', point: 8 });
    const ledger = readHumanLedger(s.task);
    s.clock.advance(NONBLOCKING_EXPIRE_MS);
    applyAskUpkeep(
      s.task,
      ledger,
      decideAskUpkeep(ledger, NONBLOCKING_EXPIRE_MS + ledger.asks[askId]!.askedAt),
    );
    expect(readHumanLedger(s.task).asks[askId]?.state).toBe('expired');
    const out = await processCommand(
      s.task,
      cmd(s.taskId, 'answer', { askId, answer: 'merge it' }),
      proof,
      commandEnv(),
    );
    expect(out).toMatchObject({ status: 'applied', outcome: { late: 'true', resumed: 'false' } });
    const after = readHumanLedger(s.task);
    expect(after.asks[askId]?.answers).toMatchObject([{ text: 'merge it', late: true }]);
    const send = pendingDeliveries(after, s.stepId);
    expect(send).toMatchObject([{ ref: { kind: 'late-answer', id: askId } }]);
    expect(send[0]?.text).toContain('merge it');
    recordDelivery(s.task, after, { stepId: s.stepId, sessionId: s.sessionId }, send[0]!.ref);
    expect(pendingDeliveries(readHumanLedger(s.task), s.stepId)).toEqual([]);
    s.task.close();
  });

  it('P71 a late answer to a withdrawn ask writes no ask transition; an ended step gets no delivery', async () => {
    const s = await setup();
    const askId = raise(s.task, s.stepId);
    failStep(s.task, s.stepId);
    const ledger = readHumanLedger(s.task);
    applyAskUpkeep(s.task, ledger, decideAskUpkeep(ledger, Date.now()));
    expect(readHumanLedger(s.task).asks[askId]?.state).toBe('withdrawn');
    const transitions = () => kinds(s.task).filter((k) => k === 'ask.transition').length;
    const before = transitions();
    const out = await processCommand(
      s.task,
      cmd(s.taskId, 'answer', { askId, answer: 'late' }),
      proof,
      commandEnv(),
    );
    expect(out).toMatchObject({ status: 'applied', outcome: { late: 'true' } });
    expect(transitions()).toBe(before);
    expect(pendingDeliveries(readHumanLedger(s.task), s.stepId)).toEqual([]);
    s.task.close();
  });

  it('F26 a message to a live step is delivered once, marked human-origin; an unknown or ended step refuses it', async () => {
    const s = await setup();
    const out = await processCommand(
      s.task,
      cmd(s.taskId, 'message-to-step', { stepId: s.stepId, text: 'use the v2 endpoint' }),
      proof,
      commandEnv(),
    );
    expect(out).toMatchObject({ status: 'applied', outcome: { stepId: s.stepId } });
    const ledger = readHumanLedger(s.task);
    const send = pendingDeliveries(ledger, s.stepId);
    expect(send).toHaveLength(1);
    expect(send[0]).toMatchObject({ ref: { kind: 'message', id: out.cmdId } });
    expect(send[0]?.text).toMatch(/^\[agentdeck · human-origin\].*\nuse the v2 endpoint$/s);
    expect(
      recordDelivery(s.task, ledger, { stepId: s.stepId, sessionId: s.sessionId }, send[0]!.ref),
    ).toBe(true);
    expect(
      recordDelivery(s.task, ledger, { stepId: s.stepId, sessionId: s.sessionId }, send[0]!.ref),
    ).toBe(false);
    expect(pendingDeliveries(readHumanLedger(s.task), s.stepId)).toEqual([]);
    expect(kinds(s.task).filter((k) => k === 'message.delivered')).toHaveLength(1);
    const unknown = await processCommand(
      s.task,
      cmd(s.taskId, 'message-to-step', { stepId: newId(), text: 'x' }),
      proof,
      commandEnv(),
    );
    expect(unknown).toMatchObject({ status: 'rejected', code: 'unknown-step' });
    failStep(s.task, s.stepId);
    const ended = await processCommand(
      s.task,
      cmd(s.taskId, 'message-to-step', { stepId: s.stepId, text: 'x' }),
      proof,
      commandEnv(),
    );
    expect(ended).toMatchObject({ status: 'rejected', code: 'step-ended' });
    s.task.close();
  });

  it('a grant is journaled only for a repo of the task', async () => {
    const s = await setup();
    const fields = { project: 'other', globs: ['migrations/**'], ops: ['edit'] };
    const bad = await processCommand(s.task, cmd(s.taskId, 'grant', fields), proof, commandEnv());
    expect(bad).toMatchObject({ status: 'rejected', code: 'unknown-project' });
    const good = await processCommand(
      s.task,
      cmd(s.taskId, 'grant', { ...fields, project: 'r1' }),
      proof,
      commandEnv(),
    );
    expect(good).toMatchObject({ status: 'applied', outcome: { project: 'r1' } });
    expect(readHumanLedger(s.task).grants).toMatchObject([
      { cmdId: good.cmdId, project: 'r1', globs: ['migrations/**'], ops: ['edit'] },
    ]);
    s.task.close();
  });
});
