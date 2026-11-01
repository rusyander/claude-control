import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FinalReport } from '@agentdeck/contracts/core/report';
import { describe, expect, it } from 'vitest';
import { humanHooks } from '../../bootstrap/conductor-wiring/human.ts';
import { openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { SEED_HUMAN_POLICY } from '../model-tools/__fixtures__/seed.ts';
import { readHumanLedger } from './ledger.ts';
import { raiseHumanPoint } from './raise.ts';

/**
 * Крючки зоны E на конце задачи (P96, F10): сначала уход за вопросами (вопрос без шага снят) и
 * уборка с чтением назад, потом отчёт — остатки отчёта говорят о том, что осталось ПОСЛЕ уборки.
 * Повтор крючка (крах после отчёта) второго отчёта не пишет.
 */

describe('human hooks at task end', () => {
  it('P96 task end withdraws step-less asks, releases own resources, then writes the report once', async () => {
    const { task, taskId } = await openFresh();
    const dir = mkdtempSync(join(tmpdir(), 'adk-end-'));
    const rid = newId();
    task.append({
      kind: 'resource.created',
      actor: 'core',
      data: { rid, kind: 'tmpdir', owner: 'core', release: 'task-end', ref: dir },
    });
    const asked = raiseHumanPoint(
      task,
      {
        source: 'launch',
        stepId: null,
        sessionId: null,
        action: null,
        point: 10,
        dedupe: null,
        question: 'launch?',
        options: ['yes'],
        recommendation: 'yes',
        blocking: true,
      },
      { policy: SEED_HUMAN_POLICY },
    );
    if (asked.kind !== 'asked') throw new Error(asked.kind);
    const hooks = humanHooks({ registry: { live: () => task }, note: () => {} } as never);
    await hooks.onTaskEnd!(taskId, 'ended');
    await hooks.onTaskEnd!(taskId, 'ended');
    expect(existsSync(dir)).toBe(false);
    expect(readHumanLedger(task).asks[asked.askId]?.state).toBe('withdrawn');
    const lines = readJournalLines(task.dir, task.taskId).lines;
    const reports = lines.filter((l) => l.kind === 'report.final');
    expect(reports).toHaveLength(1);
    const sha = (reports[0]?.data as { report: { sha256: string } }).report.sha256;
    const body = JSON.parse(
      readFileSync(join(task.dir, 'artifacts', `${sha}.json`), 'utf8'),
    ) as FinalReport;
    expect(body.residuals).toEqual([]);
    task.close();
  });
});
