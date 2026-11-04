import type { CommandEnvelope, CommandKind } from '@agentdeck/contracts/core/commands';
import { describe, expect, it } from 'vitest';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { CommandProof } from '../../policy/authority/authority.ts';
import { processCommand } from '../commands.ts';
import { commandEnv } from '../commands/__fixtures__/command-env.ts';
import { presetStep } from '../scenario/presets.ts';
import { stand, type Stand } from './__fixtures__/run-harness.ts';

/**
 * Пресет `chat@1` (этап 10) на настоящем цикле дирижёра, свёртке и входе команд: шаг чата открыт
 * между ходами (конец хода — ждать человека, а не напоминать), ход человека — `message-to-step`,
 * конец — `end-chat` (мягкое снятие, шаг сдан с основанием `human`, задача кончается). Подделана
 * только сессия модели.
 */

const proof = async (): Promise<CommandProof> => ({
  token: 'core',
  nonce: 'valid',
  peer: 'clear',
  signature: 'absent',
});

function command(s: Stand, kind: CommandKind, fields: CommandEnvelope['fields']) {
  const envelope = {
    cmdId: newId(),
    kind,
    target: { taskId: s.taskId },
    fields,
    proof: {},
  } as CommandEnvelope;
  return processCommand(s.task, envelope, proof, commandEnv());
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

async function chat(): Promise<{ s: Stand; stepId: string }> {
  const s = await stand({ id: 'chat', version: 1 }, { model: { 'chat:0': 'silent' } });
  await s.until(() => s.port.sessions.size === 1);
  return { s, stepId: Object.keys(s.task.state.steps)[0]! };
}

describe('preset chat@1: the chat step stays open between turns', () => {
  it('a turn end waits for the human (no reminder, no derived outcome); a human turn is delivered; end-chat closes the step done/human and ends the task', async () => {
    const { s, stepId } = await chat();
    const session = [...s.port.sessions.values()][0]!;
    s.port.turnEnd(stepId);
    s.run.wake();
    await settle();
    expect(s.task.state.steps[stepId]).toMatchObject({ state: 'running', reminders: 0 });
    expect(session.sends.filter((m) => m.cmdId.startsWith('remind:'))).toEqual([]);

    const msg = await command(s, 'message-to-step', { stepId, text: 'second turn' });
    expect(msg).toMatchObject({ status: 'applied' });
    s.run.wake();
    await s.until(() => session.sends.some((m) => m.text.endsWith('second turn')));
    s.port.turnEnd(stepId);
    s.run.wake();
    await settle();
    expect(s.task.state.steps[stepId]).toMatchObject({ state: 'running', reminders: 0 });

    const end = await command(s, 'end-chat', { stepId });
    expect(end).toMatchObject({ status: 'applied', outcome: { stepId } });
    s.run.wake();
    await s.until((t) => t.state.ended !== null);
    expect(s.task.state.steps[stepId]).toMatchObject({ state: 'done', basis: 'human' });
    expect(s.task.state.steps[stepId]!.reason).toBe(`end-chat: ${end.cmdId}`);
    expect(s.port.ends).toEqual([{ sessionId: [...s.port.sessions.keys()][0], mode: 'soft' }]);
    expect(s.task.state.ended).toBe('done');
    await s.stop();
  });

  it('the first word of a chat session is the human opening message as written (request.md), not a step brief', async () => {
    const s = await stand(
      { id: 'chat', version: 1 },
      { model: { 'chat:0': 'silent' }, request: 'Привет! Что в этом проекте?' },
    );
    await s.until(() => s.port.sessions.size === 1);
    const session = [...s.port.sessions.values()][0]!;
    await s.until(() => session.sends.length > 0);
    expect(session.sends[0]!.text).toBe('Привет! Что в этом проекте?');
    await s.stop();
  });

  it('a session that ends on its own without end-chat stops the step (chat-session-ended); no silent new session', async () => {
    const { s, stepId } = await chat();
    const session = [...s.port.sessions.values()][0]!;
    session.ended = true;
    session.on.ended();
    s.run.wake();
    await s.until((t) => t.state.steps[stepId]?.state === 'failed');
    expect(s.task.state.steps[stepId]!.reason).toMatch(/^chat-session-ended: /);
    expect(s.port.sessions.size).toBe(1);
    await s.stop();
  });

  it('end-chat refuses a step that is not a chat, an unknown step and a closed chat', async () => {
    const work = await stand(
      { id: 'w', version: 1, title: 't', steps: [presetStep('work', 'work', 'Работа', [])] },
      { model: { 'work:0': 'hold' } },
    );
    await work.until(() => work.port.sessions.size === 1);
    const workStep = Object.keys(work.task.state.steps)[0]!;
    expect(await command(work, 'end-chat', { stepId: workStep })).toMatchObject({
      status: 'rejected',
      code: 'not-a-chat',
    });
    expect(await command(work, 'end-chat', { stepId: newId() })).toMatchObject({
      status: 'rejected',
      code: 'unknown-step',
    });
    await work.stop();

    const { s, stepId } = await chat();
    await command(s, 'end-chat', { stepId });
    s.run.wake();
    await s.until((t) => t.state.steps[stepId]?.state === 'done');
    expect(await command(s, 'end-chat', { stepId })).toMatchObject({
      status: 'rejected',
      code: 'step-ended',
    });
    await s.stop();
  });
});
