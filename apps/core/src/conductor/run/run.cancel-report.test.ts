import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';
import { humanHooks } from '../../bootstrap/conductor-wiring/human.ts';
import { TASK_FILES } from '../../journal/journal.types.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { APPLY } from '../commands/apply.ts';
import { commandEnv } from '../commands/__fixtures__/command-env.ts';
import { ROUND_CAP_ANSWERS } from '../next/next.types.ts';
import type { ConductorHooks } from './run.types.ts';
import { openAsk, stand, type Stand } from './__fixtures__/run-harness.ts';

/**
 * Итоговый отчёт отменённой задачи (00 §Words: «Final report — the task's end message»; исход
 * `cancelled` — один из исходов отчёта). Отмена командой человека двигает машину задачи мимо
 * дирижёра; конец задачи всё равно один — крючки конца (уход за вопросами, уборка, отчёт зоны E)
 * идут ровно раз, кто бы задачу ни кончил. Крючок E — настоящий (`humanHooks`), журнал на диске.
 */

const FEATURE = { id: 'feature', version: 1 };

const lines = (s: Stand) => readJournalLines(s.dir, s.taskId).lines;
const reports = (s: Stand) => lines(s).filter((l) => l.kind === 'report.final');

/** Тело отчёта по ссылке строки: артефакт `<задача>/artifacts/<sha>.json`. */
function reportBody(s: Stand): { outcome: string; residuals: { what: string }[] } {
  const [line] = reports(s);
  const { sha256 } = (line!.data as { report: { sha256: string } }).report;
  return JSON.parse(readFileSync(join(s.dir, TASK_FILES.artifacts, `${sha256}.json`), 'utf8'));
}

/** Крючок конца задачи зоны E поверх живой задачи стенда (после перезапуска — новой). */
function humanEnd(holder: { s?: Stand }): ConductorHooks {
  const hooks = humanHooks({ registry: { live: () => holder.s?.task }, note: () => {} } as never);
  return { onTaskEnd: (taskId, at) => hooks.onTaskEnd!(taskId, at) };
}

/** Команда человека тем же путём, что у API после приёма: строка приёма, затем действие вида. */
function cancel(s: Stand) {
  const cmdId = newId();
  const target = { taskId: s.taskId };
  s.task.append({
    kind: 'command.received',
    actor: 'human:panel',
    cmdId,
    data: {
      kind: 'cancel',
      target,
      expectSeq: null,
      fields: {},
      proof: { token: 'core', nonce: 'absent', peer: 'clear', signature: 'absent' },
    } as never,
  });
  const env = { cmdId, kind: 'cancel', target, expectSeq: null, fields: {} };
  return APPLY.cancel(s.task, env as unknown as CommandEnvelope, commandEnv());
}

describe('a cancelled task carries its final report', () => {
  it('cancel command on a running task: the live session tree is stopped, report.final «cancelled» written once', async () => {
    const holder: { s?: Stand } = {};
    const s = await stand(FEATURE, { model: { 'intake:0': 'hold' } }, [humanEnd(holder)]);
    holder.s = s;
    await s.until(() => s.port.sessions.size === 1);
    const [sessionId] = [...s.port.sessions.keys()];
    const got = await cancel(s);
    expect(got.status).toBe('applied');
    await s.until(() => reports(s).length === 1);
    expect(s.task.state.ended).toBe('cancelled');
    expect(reports(s)[0]!.data).toMatchObject({ at: 'ended' });
    expect(reportBody(s).outcome).toBe('cancelled');
    expect(s.port.ends).toEqual([{ sessionId, mode: 'tree' }]);
    expect(s.calls.filter((c) => c.startsWith('task-end'))).toEqual(['task-end:ended']);
    await s.stop();
    expect(reports(s)).toHaveLength(1);
    expect(s.calls.filter((c) => c.startsWith('task-end'))).toEqual(['task-end:ended']);
  });

  it('cancel command, then the product loop stops the runner before its next pass: the report is still written', async () => {
    const holder: { s?: Stand } = {};
    const s = await stand(FEATURE, { model: { 'intake:0': 'hold' } }, [humanEnd(holder)]);
    holder.s = s;
    await s.until(() => s.port.sessions.size === 1);
    // Строки отмены ложатся синхронно; снятие исполнителя — в тот же миг, до его прохода.
    const applied = cancel(s);
    const stopped = s.run.stop();
    await applied;
    await stopped;
    expect(s.task.state.ended).toBe('cancelled');
    expect(reports(s)).toHaveLength(1);
    expect(reportBody(s).outcome).toBe('cancelled');
    expect(s.calls.filter((c) => c.startsWith('task-end'))).toEqual(['task-end:ended']);
    s.task.close();
  });

  it('cancel decided by the conductor (round-cap answer «cancel»): still exactly one end and one report', async () => {
    const model: Record<string, 'claim-blocking'> = {};
    for (const r of [0, 1, 2]) model[`review:${r}`] = 'claim-blocking';
    const holder: { s?: Stand } = {};
    const s = await stand(FEATURE, { model }, [humanEnd(holder)]);
    holder.s = s;
    await s.run.idle();
    const askId = openAsk(s.task, 'round-cap:');
    expect(askId).toBeDefined();
    await s.answer(askId!, ROUND_CAP_ANSWERS.cancel);
    await s.run.idle();
    expect(s.task.state.ended).toBe('cancelled');
    expect(reports(s)).toHaveLength(1);
    expect(reportBody(s).outcome).toBe('cancelled');
    expect(s.calls.filter((c) => c.startsWith('task-end'))).toEqual(['task-end:ended']);
    await s.stop();
    expect(reports(s)).toHaveLength(1);
  });

  it('core gone between a cancel and its close: the runner of the next core closes the ended task once', async () => {
    const holder: { s?: Stand } = {};
    const s = await stand(FEATURE, { model: { 'intake:0': 'hold' } }, [humanEnd(holder)]);
    holder.s = s;
    await s.until(() => s.port.sessions.size === 1);
    // Отмена легла в журнал, а ядро умерло до закрытия: исполнитель нового ядра видит конец без
    // отчёта (то же окно — задача кончилась, пока обход запускал исполнителя).
    await s.restart((t) => {
      const moved = t.append({
        kind: 'task.transition',
        actor: 'core',
        data: { taskId: t.taskId, event: 'cancel', from: 'running', to: 'cancelled' },
      });
      t.append({
        kind: 'task.ended',
        actor: 'core',
        cause: moved.seq,
        data: { outcome: 'cancelled' },
      });
    });
    await s.until(() => reports(s).length === 1);
    expect(reportBody(s).outcome).toBe('cancelled');
    expect(s.calls.filter((c) => c.startsWith('task-end'))).toEqual(['task-end:ended']);
    await s.stop();
    expect(reports(s)).toHaveLength(1);
  });

  it('core shutdown lands on the end line itself (stop keep): the end the conductor made is closed in the same pass', async () => {
    const holder: { s?: Stand } = {};
    const s = await stand(FEATURE, { post: { 'work:0': 'unit' } }, [humanEnd(holder)]);
    holder.s = s;
    // Снятие ядра приходит синхронно со строкой конца — до следующего прохода исполнителя.
    let stopping: Promise<void> | null = null;
    const off = s.task.subscribe((line) => {
      if (line.kind === 'task.ended') stopping ??= s.run.stop('keep');
    });
    await s.until(() => stopping !== null);
    await stopping;
    off();
    expect(s.task.state.ended).toBe('failed');
    expect(reports(s)).toHaveLength(1);
    expect(reportBody(s).outcome).toBe('failed');
    s.task.close();
  });
});
