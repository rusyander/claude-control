import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { PLATFORM_MARKER } from '@agentdeck/contracts/core/user-layer';
import { describe, expect, it } from 'vitest';
import { recordDelivery } from '../../conductor/human/deliver.ts';
import { readHumanLedger } from '../../conductor/human/ledger.ts';
import { stand, type Stand } from '../../conductor/run/__fixtures__/run-harness.ts';
import type { StepCtx } from '../../conductor/run/run.types.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { signalDef } from '../../observer/catalog.ts';
import { judgeSignal } from '../../observer/judge.ts';
import type { FiredVerdict } from '../../observer/observer.types.ts';
import { writeObserverDecision } from '../observer-wiring/write.ts';
import type { ConductorWiringDeps } from './conductor-wiring.types.ts';
import { HINT_HEAD, hintLine, observerHooks } from './observer.ts';

/**
 * Пакет подсказок наблюдателя на конце хода (этап 8, F8) через НАСТОЯЩИЙ исполнитель дирижёра:
 * строки `signal{action:'hint'}` сессии уходят ОДНИМ сообщением голосом платформы с текстом
 * каталога, строка `message.delivered{hint}` снимает их в свёртке, и ядро после перезапуска их
 * второй раз не шлёт. Ход, сдавший `step_done`, подсказки не получает.
 */

const FEATURE = { id: 'feature', version: 1 };

function hint(task: LiveTask, stepId: string, sessionId: string, signal: string, subject: string) {
  const verdict: FiredVerdict = {
    fired: true,
    signal,
    subject,
    detail: 'test fact',
    reasons: ['test'],
    key: `${signal}:${subject}:${task.state.seq}`,
    stepId,
    sessionId,
  };
  const def = signalDef(signal);
  if (!def) throw new Error(`no catalog row ${signal}`);
  return writeObserverDecision(task, verdict, judgeSignal(verdict, def), { inputs: [] });
}

const deliveredHints = (task: LiveTask) =>
  readJournalLines(task.dir, task.taskId)
    .lines.filter((l): l is JournalLine<'message.delivered'> => l.kind === 'message.delivered')
    .map((l) => l.data.ref)
    .filter((r) => r.kind === 'hint');

async function hintStand() {
  // Задача стенда меняется на перезапуске — реестр читает текущую через коробку.
  const box: { s?: Stand } = {};
  const deps = { registry: { live: () => box.s?.task } } as unknown as ConductorWiringDeps;
  const st = await stand(FEATURE, { journalSessions: true, model: { 'intake:0': 'hold' } }, [
    observerHooks(deps),
  ]);
  box.s = st;
  await st.until(() => st.port.sessions.size === 1);
  const [stepId] = Object.keys(st.task.state.steps) as [string];
  const [sessionId] = [...st.port.sessions.keys()] as [string];
  const sent: { text: string; cmdId: string; origin: string | undefined }[] = [];
  // Порт глушит дубль по cmdId сам — шпион видит каждую попытку исполнителя.
  const send = st.port.send.bind(st.port);
  st.port.send = (sid, text, cmdId, origin) => {
    sent.push({ text, cmdId, origin });
    return send(sid, text, cmdId, origin);
  };
  return { s: st, stepId, sessionId, sent };
}

describe('stage 8 observer hint batch at turn end', () => {
  it('two hints leave as ONE platform message with catalog texts; the delivered row clears them', async () => {
    const { s, stepId, sessionId, sent } = await hintStand();
    hint(s.task, stepId, sessionId, 'waste-reread', '/copy/a.ts');
    hint(s.task, stepId, sessionId, 'waste-big-read', '/copy/README.md');
    const lastId = hint(s.task, stepId, sessionId, 'waste-poll', 'sleep 30').decision.data
      .decisionId;
    expect(s.task.state.sessions[sessionId]?.hints.map((h) => h.signal)).toEqual([
      'waste-reread',
      'waste-big-read',
      'waste-poll',
    ]);
    s.port.turnEnd(stepId);
    await s.until(() => deliveredHints(s.task).length === 1);
    const hints = sent.filter((m) => m.text.startsWith(PLATFORM_MARKER));
    expect(hints).toHaveLength(1);
    const [msg] = hints;
    expect(msg?.origin).toBe('platform');
    expect(msg?.cmdId).toBe(lastId);
    expect(msg?.text.split('\n')).toEqual([
      PLATFORM_MARKER,
      HINT_HEAD,
      `- ${hintLine({ decisionId: '', seq: 0, signal: 'waste-reread', subject: '/copy/a.ts', detail: 'test fact' })}`,
      `- ${hintLine({ decisionId: '', seq: 0, signal: 'waste-big-read', subject: '/copy/README.md', detail: 'test fact' })}`,
      `- ${hintLine({ decisionId: '', seq: 0, signal: 'waste-poll', subject: 'sleep 30', detail: 'test fact' })}`,
    ]);
    expect(msg?.text).toContain('/copy/README.md is large and was read whole');
    expect(deliveredHints(s.task)).toEqual([{ kind: 'hint', id: lastId }]);
    expect(s.task.state.sessions[sessionId]?.hints).toEqual([]);
    // Следующий конец хода: подсказок нет — сообщения нет.
    s.port.turnEnd(stepId);
    await new Promise((r) => setTimeout(r, 30));
    expect(sent.filter((m) => m.text.startsWith(PLATFORM_MARKER))).toHaveLength(1);
    await s.stop();
  });

  it('same hint text twice is one line; a restarted core never re-sends a delivered batch', async () => {
    const { s, stepId, sessionId, sent } = await hintStand();
    hint(s.task, stepId, sessionId, 'waste-poll', 'sleep 30');
    hint(s.task, stepId, sessionId, 'waste-poll', 'sleep 60');
    s.port.turnEnd(stepId);
    await s.until(() => deliveredHints(s.task).length === 1);
    const [msg] = sent.filter((m) => m.text.startsWith(PLATFORM_MARKER));
    expect(msg?.text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1);
    s.port.reattach = sessionId;
    await s.restart();
    await s.until(() => s.port.opened.length === 2);
    s.port.turnEnd(stepId);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.filter((m) => m.text.startsWith(PLATFORM_MARKER))).toHaveLength(1);
    expect(deliveredHints(s.task)).toHaveLength(1);
    await s.stop();
  });

  it('a turn that handed in step_done gets no hint; an unknown task gets none either', async () => {
    const { s, stepId, sessionId } = await hintStand();
    hint(s.task, stepId, sessionId, 'waste-reread', '/copy/a.ts');
    const ctx = { taskId: s.taskId, sessionId } as unknown as StepCtx;
    const live = observerHooks({
      registry: { live: () => s.task },
    } as unknown as ConductorWiringDeps);
    expect(await live.onTurnEnd!(ctx, { seq: 1, hadStepDone: true })).toEqual({ send: [] });
    expect((await live.onTurnEnd!(ctx, { seq: 1, hadStepDone: false })).send).toHaveLength(1);
    const gone = observerHooks({
      registry: { live: () => undefined },
    } as unknown as ConductorWiringDeps);
    expect(await gone.onTurnEnd!(ctx, { seq: 1, hadStepDone: false })).toEqual({ send: [] });
    await s.stop();
  });

  it('recordDelivery writes a hint row once per decision and none for a reminder', async () => {
    const { s, stepId, sessionId } = await hintStand();
    const { decision } = hint(s.task, stepId, sessionId, 'waste-reread', '/copy/a.ts');
    const id = decision.data.decisionId;
    const at = { stepId, sessionId };
    expect(recordDelivery(s.task, readHumanLedger(s.task), at, { kind: 'hint', id })).toBe(true);
    expect(recordDelivery(s.task, readHumanLedger(s.task), at, { kind: 'hint', id })).toBe(false);
    expect(
      recordDelivery(s.task, readHumanLedger(s.task), at, { kind: 'reminder', id: 'r-1' } as never),
    ).toBe(false);
    expect(deliveredHints(s.task)).toEqual([{ kind: 'hint', id }]);
    expect(s.task.state.sessions[sessionId]?.hints).toEqual([]);
    await s.stop();
  });
});
