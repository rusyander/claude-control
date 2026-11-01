import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finalReportSchema } from '@agentdeck/contracts/core/report';
import { describe, expect, it } from 'vitest';
import { openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { sha256OfText } from '../../journal/line.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { readHumanLedger } from '../human/ledger.ts';
import { raiseHumanPoint } from '../human/raise.ts';
import {
  R1,
  R2,
  seedRequirements,
  seedSession,
  SEED_HUMAN_POLICY,
} from '../model-tools/__fixtures__/seed.ts';
import { buildFinalReport, writeFinalReport } from './report.ts';

/**
 * P96 (00 §Words «Final report», 06 §Human points): итоговый отчёт собран из журнала — развилки,
 * решённые по умолчанию (вопрос модели вне списка, умолчание ядра без модели), непроверенное
 * (требование `unknown`), остатки (утечка, открытый вопрос), поздний ответ; тело — артефакт по
 * sha256, строка `report.final` одна на точку.
 */

async function seeded() {
  const { task, taskId } = await openFresh();
  const s = seedSession(task, { stepKind: 'work' });
  seedRequirements(task, [R1, R2]);
  task.append({
    kind: 'requirement.verdict',
    actor: 'core',
    data: {
      requirementId: R2,
      verdict: 'unknown',
      evidence: [],
      reason: 'derived',
      decisionSeq: 1,
    },
  });
  // Вопрос модели вне списка — развилка; пункт 8 — открытый вопрос в остатках.
  raiseHumanPoint(
    task,
    {
      source: 'ask_human',
      stepId: s.stepId,
      sessionId: s.sessionId,
      action: null,
      point: null,
      dedupe: null,
      question: 'tabs or spaces?',
      options: ['tabs', 'spaces'],
      recommendation: 'spaces',
      blocking: false,
    },
    { policy: SEED_HUMAN_POLICY },
  );
  raiseHumanPoint(
    task,
    {
      source: 'scenario-step',
      stepId: s.stepId,
      sessionId: null,
      action: null,
      point: 8,
      dedupe: null,
      question: 'approve the plan?',
      options: ['yes', 'no'],
      recommendation: 'yes',
      blocking: true,
    },
    { policy: SEED_HUMAN_POLICY },
  );
  // Умолчание ядра без модели (G8): дважды — в отчёте одна строка. С фазы 5 `tier` моделируется
  // (`basis: modelled`) и умолчанием не считается; публикация ждёт фазы 6.
  for (let i = 0; i < 2; i += 1) {
    task.append({
      kind: 'decision',
      actor: 'core',
      stepId: s.stepId,
      data: {
        decisionId: newId(),
        class: 'publish-ready',
        inputs: [],
        facts: [],
        numbers: {},
        reasons: ['publish is not built before phase 6'],
        output: { basis: 'not-implemented-until-phase-6' },
      },
    });
  }
  const rid = newId();
  task.append({
    kind: 'resource.created',
    actor: 'core',
    data: { rid, kind: 'tmpdir', owner: 'core', release: 'task-end', ref: '/tmp/x' },
  });
  task.append({ kind: 'resource.leak', actor: 'core', data: { rid, reason: 'locked' } });
  return { task, taskId, rid, ...s };
}

describe('P96 final report', () => {
  it('P96 lists defaulted forks once each, unknown requirements, leaks and open asks', async () => {
    const s = await seeded();
    const report = buildFinalReport(readHumanLedger(s.task), {
      taskId: s.taskId,
      at: 'ended',
      ended: 'failed',
    });
    expect(finalReportSchema.parse(report)).toEqual(report);
    expect(report.outcome).toBe('failed');
    expect(report.forks).toMatchObject([
      { source: 'ask_human', question: 'tabs or spaces?', chosen: 'spaces' },
      { source: 'core', chosen: 'not-implemented-until-phase-6' },
    ]);
    expect(report.requirements.map((r) => [r.requirementId, r.verdict])).toEqual([
      [R1, 'open'],
      [R2, 'unknown'],
    ]);
    expect(report.unverified).toHaveLength(1);
    expect(report.unverified[0]?.what).toMatch(/^R2: /);
    expect(report.residuals.map((r) => r.why)).toEqual([
      'release could not be read back',
      'item 8 still waits for the human',
    ]);
    s.task.close();
  });

  it('P96 the body is an artifact by sha256 and report.final is written once per point', async () => {
    const s = await seeded();
    const first = writeFinalReport(s.task, { at: 'ready-to-publish', ended: null });
    if (first.kind !== 'written') throw new Error(first.kind);
    const body = readFileSync(join(s.task.dir, 'artifacts', `${first.sha256}.json`), 'utf8');
    expect(sha256OfText(body)).toBe(first.sha256);
    expect(finalReportSchema.parse(JSON.parse(body)).outcome).toBe('ready-to-publish');
    expect(writeFinalReport(s.task, { at: 'ready-to-publish', ended: null })).toEqual({
      kind: 'exists',
    });
    expect(writeFinalReport(s.task, { at: 'ended', ended: 'done' }).kind).toBe('written');
    const lines = readJournalLines(s.task.dir, s.task.taskId).lines;
    expect(
      lines.filter((l) => l.kind === 'report.final').map((l) => (l.data as { at: string }).at),
    ).toEqual(['ready-to-publish', 'ended']);
    s.task.close();
  });
});
