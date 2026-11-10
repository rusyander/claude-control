import { claudeRunFacts } from '@agentdeck/providers/claude';
import { tierLadderOf } from '@agentdeck/providers/ladder';
import type { JournalDataV1, JournalLine } from '@agentdeck/contracts/core/journal';
import type { LeadProfile } from '@agentdeck/contracts/core/lead';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { describe, expect, it } from 'vitest';
import { createRunEconomy } from '../../bootstrap/economy-wiring/continuation.ts';
import type { ContourPolicy } from '../../policy/resolve/resolve.types.ts';
import type { TierLadder } from '../../economy/tier.types.ts';
import { WindowBook } from '../../economy/window/index.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { humanLedger } from '../human/ledger.ts';
import { buildFinalReport } from '../report/report.ts';
import { presetOf, presetStep } from '../scenario/presets.ts';
import { attempts, stand, type Script, type Stand } from './__fixtures__/run-harness.ts';

/**
 * Второе ревью «Максимума качества» (этап 12, P185) на настоящем цикле дирижёра: свёртка, судья
 * `next` с судьёй формы (`lead-gate`), суд `tier` (`routeStep`) с фактами шага загрузки
 * (`createRunEconomy` → `routing-facts`), исполнитель и итоговый отчёт из книги человека.
 * Подделаны только сессия модели (заявление шага, находки) и вердикт крючков — стенд `run-harness`.
 */

type Route = JournalDataV1['task.created']['allowedRoutes'][number];

const CLAUDE: Route = {
  adapter: 'claude',
  route: { kind: 'cli-login', id: 'claude-login' },
  modelPattern: '*',
};
const CODEX: Route = {
  adapter: 'codex',
  route: { kind: 'cli-login', id: 'codex-login' },
  modelPattern: '*',
};

const LADDERS: Readonly<Record<string, TierLadder>> = {
  claude: tierLadderOf(claudeRunFacts) as TierLadder,
};

/** Хвост ведущего lead@2: работа → ревью → второе ревью (шаг пресета как есть) → правки. */
function scenario(): Scenario {
  const cross = presetOf({ id: 'lead', version: 2 })!.steps.find((s) => s.id === 'review-cross')!;
  return {
    id: 'cross-review',
    version: 1,
    title: 't',
    steps: [
      presetStep('work', 'work', 'Работа', []),
      presetStep('review', 'review', 'Ревью', ['work']),
      cross,
      presetStep('fix', 'fix', 'Правки по ревью', ['review']),
    ],
  };
}

async function run(
  profile: LeadProfile | null,
  script: Script,
  more: { contour?: ContourPolicy; crossRoutes?: Route[] } = {},
): Promise<Stand> {
  const base = scenario();
  const steps = more.crossRoutes
    ? base.steps.map((st) =>
        st.id === 'review-cross' ? { ...st, model: { ...st.model, routes: more.crossRoutes } } : st,
      )
    : base.steps;
  const s = await stand(
    { ...base, steps },
    {
      journalSessions: true,
      economy: createRunEconomy({
        windows: new WindowBook(),
        now: () => 1_000,
        ladders: LADDERS,
        ...(more.contour ? { contour: () => more.contour } : {}),
      }),
      ...(profile ? { lead: { profile } } : {}),
      ...script,
    },
  );
  await s.until((t) => t.state.task === 'done' || t.state.task === 'failed', 10_000);
  await s.stop();
  return s;
}

const lines = (s: Stand): JournalLine[] => readJournalLines(s.dir, s.taskId).lines;

/** Сессии по шагу сценария и кругу: `<def>:<round>` → переходник. */
function adapters(s: Stand): string[] {
  return Object.values(s.task.state.sessions).map((x) => {
    const step = s.task.state.steps[x.stepId]!;
    return `${step.stepDefId}:${step.round}:${x.adapter}`;
  });
}

/** Решение `tier` шага второго ревью (первое). */
function crossTier(s: Stand): JournalDataV1['decision'] | undefined {
  for (const l of lines(s)) {
    if (l.kind !== 'decision' || !l.stepId) continue;
    const d = (l as JournalLine<'decision'>).data;
    if (d.class === 'tier' && s.task.state.steps[l.stepId]?.stepDefId === 'review-cross') return d;
  }
  return undefined;
}

function report(s: Stand) {
  return buildFinalReport(humanLedger(lines(s)), { taskId: s.taskId, at: 'ended', ended: 'done' });
}

describe('stage 12: strict second reviewer (review-cross) on the real run path', () => {
  it('max-quality, two adapters allowed: review-cross runs on the other adapter; the tier decision names avoidAdapter', async () => {
    const s = await run('max-quality', { routes: [CLAUDE, CODEX] });
    expect(s.task.state.task).toBe('done');
    expect(adapters(s)).toEqual(['work:0:claude', 'review:0:claude', 'review-cross:0:codex']);
    const d = crossTier(s)!;
    expect(d.output).toMatchObject({ adapter: 'codex' });
    expect(d.numbers.avoided).toBe(1);
    expect(d.reasons.join('\n')).toContain('avoided: avoidAdapter claude');
    expect(
      report(s)
        .unverified.map((u) => u.why)
        .join('\n'),
    ).not.toContain('cross-review');
  });

  it('max-quality, one adapter allowed: review-cross skipped, the reason lands in the final report', async () => {
    const s = await run('max-quality', { routes: [CLAUDE] });
    expect(s.task.state.task).toBe('done');
    expect(attempts(s.task)).toContain('review-cross:0:skipped:core');
    expect(adapters(s).some((a) => a.startsWith('review-cross'))).toBe(false);
    const why =
      "cross-review: no allowed adapter other than claude, the first reviewer's (step review); step review-cross skipped, the change has one reviewer";
    const cross = Object.values(s.task.state.steps).find((x) => x.stepDefId === 'review-cross')!;
    expect(cross.reason).toBe(why);
    expect(report(s).unverified).toContainEqual(
      expect.objectContaining({ what: expect.stringContaining('(review) skipped'), why }),
    );
  });

  it('max-quality, two adapters allowed, a required contour leaves only the first reviewer: review-cross skipped with the contour reason, never a failed step', async () => {
    // Второе ревью приколото к маршрутам [codex по входу CLI, claude через шлюз c1]. Обязательный
    // контур c1 уводит всё на шлюз — вход codex из набора уходит, остаётся только claude, первый
    // ревьюер. Без контура в суде формы шаг шёл в суд `tier` и падал.
    const s = await run(
      'max-quality',
      { routes: [CLAUDE, CODEX] },
      {
        contour: { contourId: 'c1', mode: 'required', gateway: 'up', model: 'local-model' },
        crossRoutes: [
          CODEX,
          { adapter: 'claude', route: { kind: 'gateway', id: 'gateway:c1' }, modelPattern: '*' },
        ],
      },
    );
    expect(s.task.state.task).toBe('done');
    expect(attempts(s.task)).toContain('review-cross:0:skipped:core');
    expect(attempts(s.task).some((a) => a.startsWith('review-cross') && a.includes('failed'))).toBe(
      false,
    );
    const cross = Object.values(s.task.state.steps).find((x) => x.stepDefId === 'review-cross')!;
    expect(cross.reason).toBe(
      "cross-review: contour leaves no other CLI than claude, the first reviewer's (step review); step review-cross skipped, the change has one reviewer",
    );
    expect(report(s).unverified).toContainEqual(
      expect.objectContaining({ why: expect.stringMatching(/^cross-review: contour leaves/) }),
    );
  });

  it('max-quality, one adapter, a fix round: the cross review is skipped again by the rule, the report names it once', async () => {
    const s = await run('max-quality', {
      routes: [CLAUDE],
      model: { 'review:0': 'claim-blocking' },
    });
    expect(s.task.state.task).toBe('done');
    expect(attempts(s.task).filter((a) => a.startsWith('review-cross'))).toEqual([
      'review-cross:0:skipped:core',
      'review-cross:0:skipped:core',
    ]);
    expect(adapters(s).some((a) => a.startsWith('review-cross'))).toBe(false);
    expect(report(s).unverified.filter((u) => u.why.startsWith('cross-review:'))).toHaveLength(1);
  });

  it('balanced: no review-cross ever, not even after a fix round makes the review run again', async () => {
    const s = await run('balanced', {
      routes: [CLAUDE, CODEX],
      model: { 'review:0': 'claim-blocking' },
    });
    expect(s.task.state.task).toBe('done');
    expect(adapters(s).some((a) => a.startsWith('review-cross'))).toBe(false);
    expect(attempts(s.task).filter((a) => a.startsWith('review-cross'))).toEqual([
      'review-cross:0:skipped:core',
      'review-cross:0:skipped:core',
    ]);
    expect(attempts(s.task)).toContain('fix:0:done:claimed');
    expect(
      report(s)
        .unverified.map((u) => u.why)
        .join('\n'),
    ).not.toContain('cross-review');
  });

  it('a blocking finding of review-cross alone sends the unit to fix; its clean claim never skips a blocked review', async () => {
    const crossOnly = await run('max-quality', {
      routes: [CLAUDE, CODEX],
      model: { 'review-cross:0': 'claim-blocking' },
    });
    expect(attempts(crossOnly.task)).toContain('fix:0:done:claimed');
    const reviewOnly = await run('max-quality', {
      routes: [CLAUDE, CODEX],
      model: { 'review:0': 'claim-blocking' },
    });
    expect(attempts(reviewOnly.task)).toContain('fix:0:done:claimed');
  });

  it('after the cross review the fix and the next review round stay on the work adapter, the cross review keeps its own', async () => {
    const s = await run('max-quality', {
      routes: [CLAUDE, CODEX],
      model: { 'review-cross:0': 'claim-blocking' },
    });
    expect(s.task.state.task).toBe('done');
    expect(adapters(s)).toEqual([
      'work:0:claude',
      'review:0:claude',
      'review-cross:0:codex',
      'fix:0:claude',
      'review:1:claude',
      'review-cross:1:codex',
    ]);
  });
});
