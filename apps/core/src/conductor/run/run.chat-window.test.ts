import type { CommandEnvelope, CommandKind } from '@agentdeck/contracts/core/commands';
import type { WindowDecision, WindowVerdict } from '@agentdeck/contracts/core/economy';
import { describe, expect, it } from 'vitest';
import { DEFERRABLE } from '../../economy/window/index.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { CommandProof } from '../../policy/authority/authority.ts';
import { processCommand } from '../commands.ts';
import { commandEnv } from '../commands/__fixtures__/command-env.ts';
import { HUMAN_MARK } from '../human/deliver.ts';
import { stand, type Stand } from './__fixtures__/run-harness.ts';
import type { RunEconomy } from './run.types.ts';

/**
 * Чат (`chat@1`) упёрся в окно подписки (этап 12, L3): живой путь «Ждать сброса» — это ожидание
 * окна самим ядром (сессия снята в конце хода, задача в `waiting-window`, на сбросе — новая
 * сессия того же шага). Панель после лимита ничего не шлёт (прежний `run-retry` был мёртв).
 * Здесь — что новая сессия получает на сбросе: ровно одно слово, и это слово человека, на
 * которое окно не дало ответа (последнее сообщение, а если отказ был на первом — первое);
 * ход, на который модель ответила, не повторяется — сессия ждёт человека. Подделаны только
 * сессия модели и книга окон.
 */

function verdict(routeId: string, v: WindowVerdict): WindowDecision {
  const holds = v === 'open' || v === 'warn' ? [] : [...DEFERRABLE];
  return { routeId, limitKind: 'window', verdict: v, defer: holds, resumeAt: null, reasons: [v] };
}

function book(): RunEconomy & { set(routeId: string, v: WindowVerdict | null): void } {
  const by = new Map<string, WindowDecision>();
  return {
    set(routeId, v) {
      if (v === null) by.delete(routeId);
      else by.set(routeId, verdict(routeId, v));
    },
    windows: (routeId) => {
      const d = by.get(routeId);
      return d ? [d] : [];
    },
    routingEnv: () => ({ windows: [...by.values()] }),
    recheckMs: 10,
  };
}

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

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LIMIT = "You've hit your limit · resets 3pm (Europe/Moscow)";
const ROUTE_ID = 'claude-login';

interface Chat {
  s: Stand;
  econ: ReturnType<typeof book>;
  stepId: string;
  first: string;
}

async function chat(): Promise<Chat> {
  const econ = book();
  const s = await stand(
    { id: 'chat', version: 1 },
    {
      model: { 'chat:0': 'silent' },
      request: 'Q1 первый вопрос',
      economy: econ,
      journalSessions: true,
    },
  );
  await s.until(() => s.port.sessions.size === 1);
  const first = [...s.port.sessions.keys()][0]!;
  await s.until(() => s.port.sessions.get(first)!.sends.length === 1);
  return { s, econ, stepId: Object.keys(s.task.state.steps)[0]!, first };
}

/** Конец хода, на который окно отказало: ошибка хода, вердикт окна, конец хода. */
function refusedTurn(c: Chat, sessionId: string): void {
  const sess = c.s.port.sessions.get(sessionId)!;
  sess.on.turnError?.(LIMIT);
  c.econ.set(ROUTE_ID, 'refused');
  sess.on.turnEnded();
}

async function resetAndReopen(c: Chat): Promise<string> {
  await c.s.until((t) => t.state.task === 'waiting-window');
  expect(c.s.port.ends).toHaveLength(1);
  c.econ.set(ROUTE_ID, null);
  await c.s.until(() => c.s.port.opened.length === 2);
  const second = [...c.s.port.sessions.keys()].find((id) => id !== c.first)!;
  await pause(80);
  return second;
}

describe('chat@1 and the subscription window (stage 12, L3)', () => {
  it('refused on a later message: at reset the new session gets exactly that message once, as the human, not the opening', async () => {
    const c = await chat();
    const one = c.s.port.sessions.get(c.first)!;
    c.s.port.turnEnd(c.stepId);
    c.s.run.wake();
    const msg = await command(c.s, 'message-to-step', { stepId: c.stepId, text: 'Q2 второй' });
    expect(msg).toMatchObject({ status: 'applied' });
    await c.s.until(() => one.sends.some((m) => m.text.endsWith('Q2 второй')));
    refusedTurn(c, c.first);
    const second = await resetAndReopen(c);
    const sends = c.s.port.sessions.get(second)!.sends;
    expect(sends).toHaveLength(1);
    expect(sends[0]!.origin).toBe('human');
    expect(sends[0]!.text.startsWith(HUMAN_MARK)).toBe(true);
    expect(sends[0]!.text.endsWith('Q2 второй')).toBe(true);
    expect(sends[0]!.text).not.toContain('Q1');
    expect(one.sends.map((m) => m.cmdId)).not.toContain(sends[0]!.cmdId);
    await c.s.stop();
  });

  it('refused on the very first word: at reset the opening goes again, once', async () => {
    const c = await chat();
    refusedTurn(c, c.first);
    const second = await resetAndReopen(c);
    expect(c.s.port.sessions.get(second)!.sends.map((m) => m.text)).toEqual(['Q1 первый вопрос']);
    // Ключ повтора — не ключ первой отправки: ключ-UUID становится uuid сообщения CLI, и Claude,
    // продолжая тот же разговор, отбросил бы сообщение с уже виденным uuid (живой прогон этапа 12).
    const firstKeys = c.s.port.sessions.get(c.first)!.sends.map((m) => m.cmdId);
    const resend = c.s.port.sessions.get(second)!.sends[0]!.cmdId;
    expect(firstKeys).toEqual([c.stepId]);
    expect(resend).not.toBe(c.stepId);
    expect(resend).toBe(`${c.stepId}:reopen:${second}`);
    await c.s.stop();
  });

  it('an answered turn parked by a held window: no word at reset, the next human message is delivered to the new session', async () => {
    const c = await chat();
    const one = c.s.port.sessions.get(c.first)!;
    c.econ.set(ROUTE_ID, 'held');
    one.on.turnEnded();
    const second = await resetAndReopen(c);
    const sends = c.s.port.sessions.get(second)!.sends;
    expect(sends).toEqual([]);
    const msg = await command(c.s, 'message-to-step', {
      stepId: c.stepId,
      text: 'Q3 после сброса',
    });
    expect(msg).toMatchObject({ status: 'applied' });
    c.s.run.wake();
    await c.s.until(() => sends.length === 1);
    expect(sends[0]!.text.endsWith('Q3 после сброса')).toBe(true);
    expect(c.s.port.opened).toHaveLength(2);
    await c.s.stop();
  });
});
