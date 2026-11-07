import { claudeRunFacts } from '@agentdeck/providers/claude';
import { tierLadderOf } from '@agentdeck/providers/ladder';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { LeadSection } from '@agentdeck/contracts/core/lead';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { describe, expect, it } from 'vitest';
import { createRunEconomy } from '../../bootstrap/economy-wiring/continuation.ts';
import { learnedRaiseFor } from '../../bootstrap/economy-wiring/routing-facts.ts';
import type { LearnedTable } from '../../economy/learned/index.ts';
import type { TierLadder } from '../../economy/tier.types.ts';
import { WindowBook } from '../../economy/window/index.ts';
import { CREATED } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { presetStep } from '../scenario/presets.ts';
import { stand, type Script, type Stand } from './__fixtures__/run-harness.ts';
import type { ConductorHooks, RunEconomy } from './run.types.ts';

/**
 * Роль шага и ступень вверх после провала (этап 11, W2-10, D7, D21) на настоящем цикле дирижёра:
 * свёртка, суд `tier` (`routeStep`), порт экономики загрузки (`createRunEconomy` с фактами шага
 * `routing-facts.ts`) и лестница Claude из фактов запуска. Подделаны сессия модели и вердикт
 * проверки (`post: red`); запись вывода красной проверки — строки `check.*`, как их пишет ядро.
 */

const LADDERS: Readonly<Record<string, TierLadder>> = {
  claude: tierLadderOf(claudeRunFacts) as TierLadder,
};
const REPO = CREATED.repos[0]?.repoKey ?? 'r1';
const RECORD = `${'b'.repeat(64)}.0`;

function scenario(withReview = false): Scenario {
  const work = presetStep('work', 'work', 'Работа', []);
  const steps = withReview ? [work, presetStep('review', 'review', 'Ревью', ['work'])] : [work];
  return { id: 'escalation', version: 1, title: 't', steps };
}

const economy = (section?: LeadSection) =>
  createRunEconomy({
    windows: new WindowBook(),
    now: () => 1_000,
    ladders: LADDERS,
    facts: { leadSection: () => section },
  });

/** Красная проверка шага с записью вывода — как её пишет ядро (`check.requested` + `recorded`). */
const recordOnRed: ConductorHooks = {
  postStep: async (s) => {
    if (s.def.id !== 'work' || s.round !== 0) return { verdict: { ok: true }, facts: {} };
    const task = current as Stand;
    const checkRunId = newId();
    task.task.append({
      kind: 'check.requested',
      actor: 'core',
      data: {
        checkRunId,
        checkId: 'unit:web',
        unit: 'web',
        key: 'a'.repeat(64),
        grade: 'narrow',
        origin: 'core',
        road: 'conductor',
        stepId: s.stepId,
      },
    });
    task.task.append({
      kind: 'check.recorded',
      actor: 'core',
      data: { checkRunId, recordId: RECORD },
    });
    return { verdict: { ok: true }, facts: {} };
  },
};
let current: Stand | null = null;

interface TierOut {
  model: string | null;
  effort: string | null;
  applied: string;
  role: string | null;
  roleSource: string;
  sources: { model: string; effort: string };
  cause: { stepId: string; recordId: string | null; why: string } | null;
  atCeiling: boolean;
}

function tiers(s: Stand): { stepDefId: string; round: number; out: TierOut; reasons: string[] }[] {
  const lines = readJournalLines(s.dir, s.taskId).lines;
  return lines.flatMap((l) => {
    if (l.kind !== 'decision' || !l.stepId) return [];
    const d = (l as JournalLine<'decision'>).data;
    const step = s.task.state.steps[l.stepId];
    if (d.class !== 'tier' || !step) return [];
    return [
      {
        stepDefId: step.stepDefId,
        round: step.round,
        out: d.output as unknown as TierOut,
        reasons: d.reasons,
      },
    ];
  });
}

async function run(script: Script, withReview = false): Promise<Stand> {
  const s = await stand(scenario(withReview), { journalSessions: true, ...script }, [recordOnRed]);
  current = s;
  await s.until((t) => t.state.task === 'done' || t.state.task === 'failed', 10_000);
  await s.stop();
  return s;
}

describe('stage 11: role routing and rung escalation on the real run path', () => {
  it('a lowered mechanical step goes red → attempt 2 one rung up, source escalation, cause names the record', async () => {
    const s = await run({
      modelCeiling: 'opus',
      lead: { profile: 'balanced' },
      unitRole: 'mechanical',
      economy: economy(),
      post: { 'work:0': 'red' },
    });
    const [first, second] = tiers(s);
    expect(first).toMatchObject({
      stepDefId: 'work',
      round: 0,
      out: {
        model: 'sonnet',
        effort: 'high',
        applied: 'lowered',
        role: 'mechanical',
        roleSource: 'profile',
      },
    });
    expect(second?.round).toBe(1);
    expect(second?.out).toMatchObject({
      model: 'sonnet',
      effort: 'xhigh',
      roleSource: 'escalation',
      sources: { effort: 'escalation' },
      atCeiling: false,
    });
    expect(second?.out.cause).toMatchObject({ why: 'red-check', recordId: RECORD });
    // Сессия второй попытки спрошена на новой ступени — строка `session.started`, как у дороги.
    const asked = Object.values(s.task.state.sessions).map((x) => x.modelAsked);
    expect(asked).toEqual(['sonnet', 'sonnet']);
  });

  it('a review step on a row weaker than the author → raised to the author and named', async () => {
    const section: LeadSection = {
      projects: { [REPO]: { roles: { review: { tier: 'ceiling', effort: 'low' } } } },
    };
    const s = await run(
      { modelCeiling: 'opus', lead: { profile: 'balanced' }, economy: economy(section) },
      true,
    );
    const review = tiers(s).find((t) => t.stepDefId === 'review');
    expect(review?.out).toMatchObject({
      model: 'opus',
      effort: 'high',
      role: 'review',
      sources: { effort: 'author' },
    });
    expect(review?.reasons.join('; ')).toMatch(/reviewer raised to the author: effort low < high/);
  });

  it('a step at opus·xhigh fails → retried at opus·xhigh, named «потолок»', async () => {
    const section: LeadSection = {
      projects: { [REPO]: { roles: { implement: { tier: 'ceiling', effort: 'xhigh' } } } },
    };
    const s = await run({
      modelCeiling: 'opus',
      lead: { profile: 'balanced' },
      economy: economy(section),
      post: { 'work:0': 'red' },
    });
    const [first, second] = tiers(s);
    expect(first?.out).toMatchObject({ model: 'opus', effort: 'xhigh', roleSource: 'project' });
    expect(second?.out).toMatchObject({ model: 'opus', effort: 'xhigh', atCeiling: true });
    expect(second?.reasons.join('; ')).toMatch(/потолок/);
    // Эскалация выбор не сдвинула — источник тот же, что у первой попытки, не «эскалация».
    expect(second?.out).toMatchObject({
      roleSource: 'project',
      sources: { model: first?.out.sources.model, effort: first?.out.sources.effort },
    });
  });

  it('a task ceiling below the ladder top holds: sonnet·xhigh fails under ceiling sonnet → retried at sonnet·xhigh, never opus', async () => {
    const section: LeadSection = {
      projects: { [REPO]: { roles: { implement: { tier: 'ceiling', effort: 'xhigh' } } } },
    };
    const s = await run({
      modelCeiling: 'sonnet',
      lead: { profile: 'balanced' },
      economy: economy(section),
      post: { 'work:0': 'red' },
    });
    const [first, second] = tiers(s);
    expect(first?.out).toMatchObject({ model: 'sonnet', effort: 'xhigh' });
    expect(second?.out).toMatchObject({ model: 'sonnet', effort: 'xhigh', atCeiling: true });
  });

  it('a prior attempt above the auto ceiling by a human pick of THAT attempt → the retry steps from the base pick, never kept above the task ceiling', async () => {
    // Человек назвал opus только первой попытке (правка `step`); вторая попытка — новый шаг без
    // правки: эскалация не вправе унести её выше потолка задачи (sonnet).
    const base = economy();
    let pinned = false;
    const pinFirst: RunEconomy = {
      ...base,
      routingEnv: (task) => {
        const first = Object.entries(task.state.steps).find(
          ([, st]) => st.stepDefId === 'work' && st.round === 0,
        );
        if (!pinned && first) {
          pinned = true;
          const cmdId = newId();
          task.append({
            kind: 'override.set',
            actor: 'core',
            cmdId,
            data: {
              cmdId,
              scope: 'step',
              scopeId: first[0],
              field: 'model',
              value: 'opus',
              timing: 'now',
            },
          });
        }
        return (base.routingEnv as NonNullable<RunEconomy['routingEnv']>)(task);
      },
    };
    const s = await run({
      modelCeiling: 'sonnet',
      lead: { profile: 'balanced' },
      economy: pinFirst,
      post: { 'work:0': 'red' },
    });
    const [first, second] = tiers(s);
    expect(first?.out).toMatchObject({ model: 'opus', effort: 'high', roleSource: 'human' });
    expect(second?.out).toMatchObject({
      model: 'sonnet',
      effort: 'xhigh',
      roleSource: 'escalation',
      atCeiling: false,
    });
    expect(second?.reasons.join('; ')).toMatch(/opus is above the auto ceiling/);
  });

  it('the review step of a role-bearing piece routes by the review row, not by the piece role', async () => {
    // max-quality: механика ceiling·high, ревью ceiling·xhigh — ревью механического куска xhigh.
    const s = await run(
      {
        modelCeiling: 'opus',
        lead: { profile: 'max-quality' },
        unitRole: 'mechanical',
        economy: economy(),
      },
      true,
    );
    const work = tiers(s).find((t) => t.stepDefId === 'work');
    const review = tiers(s).find((t) => t.stepDefId === 'review');
    expect(work?.out).toMatchObject({ role: 'mechanical', effort: 'high' });
    expect(review?.out).toMatchObject({ role: 'review', effort: 'xhigh', roleSource: 'profile' });
  });

  it('a step that wrote no code (intake) is not the author a reviewer is raised to', async () => {
    const section: LeadSection = {
      projects: { [REPO]: { roles: { intake: { tier: 'ceiling', effort: 'xhigh' } } } },
    };
    const steps = [
      presetStep('intake', 'intake', 'Разбор', []),
      presetStep('review', 'review', 'Ревью', ['intake']),
    ];
    const s = await stand(
      { id: 'review-after-intake', version: 1, title: 't', steps },
      {
        journalSessions: true,
        modelCeiling: 'opus',
        lead: { profile: 'balanced' },
        economy: economy(section),
      },
    );
    await s.until((t) => t.state.task === 'done' || t.state.task === 'failed', 10_000);
    await s.stop();
    const intake = tiers(s).find((t) => t.stepDefId === 'intake');
    const review = tiers(s).find((t) => t.stepDefId === 'review');
    expect(intake?.out).toMatchObject({ effort: 'xhigh' });
    expect(review?.out).toMatchObject({
      model: 'opus',
      effort: 'high',
      sources: { effort: 'profile' },
    });
    expect(review?.reasons.join('; ')).not.toMatch(/reviewer raised to the author/);
  });

  it('the core config lead section is read once per routing pass, shared by the role row and the learned raise of every step it routes', async () => {
    let reads = 0;
    const section = (): LeadSection | undefined => {
      reads += 1;
      return undefined;
    };
    // Таблица выученного есть (пустая) — подъём по обучению доходит до чтения порога.
    const table: LearnedTable = { byKey: {}, byKind: {}, tasks: [], skipped: 0, firstPass: {} };
    const inner = createRunEconomy({
      windows: new WindowBook(),
      now: () => 1_000,
      ladders: LADDERS,
      facts: {
        leadSection: section,
        learnedRaise: learnedRaiseFor({ table: () => table, leadSection: section }),
      },
    });
    // Проход суда — одна среда `routingEnv` (шаг дирижёра, проверка окон): считаем те, что судили.
    let passes = 0;
    const counted: RunEconomy = {
      ...inner,
      routingEnv: (task) => {
        const env = (inner.routingEnv as NonNullable<RunEconomy['routingEnv']>)(task);
        const step = env.step!;
        let used = false;
        return {
          ...env,
          step: (st, where) => {
            if (!used) passes += 1;
            used = true;
            return step(st, where);
          },
        };
      },
    };
    const s = await run(
      { modelCeiling: 'opus', lead: { profile: 'balanced' }, economy: counted },
      true,
    );
    expect(tiers(s)).toHaveLength(2);
    expect(passes).toBeGreaterThan(0);
    expect(reads).toBe(passes);
  });

  it('a parallel custom step started after the work is not the author: the reviewer is raised to the work step', async () => {
    // Без профиля ведения ступень — уровень шага сценария: работа high, свой шаг xhigh, ревью low.
    const at = (def: ReturnType<typeof presetStep>, effort: string) => ({
      ...def,
      model: { tier: 'ceiling' as const, effort },
    });
    const steps = [
      at(presetStep('work', 'work', 'Работа', []), 'high'),
      at(presetStep('side', 'custom', 'Свой шаг', ['work']), 'xhigh'),
      at(presetStep('review', 'review', 'Ревью', ['work']), 'low'),
    ];
    const s = await stand(
      { id: 'review-beside-custom', version: 1, title: 't', steps },
      { journalSessions: true, modelCeiling: 'opus', economy: economy() },
    );
    await s.until((t) => t.state.task === 'done' || t.state.task === 'failed', 10_000);
    await s.stop();
    const byDef = (id: string) => Object.values(s.task.state.steps).find((x) => x.stepDefId === id);
    // Свой шаг начат раньше ревью — иначе проверка не о «соседе, начатом до ревью».
    expect(byDef('side')!.startedSeq).toBeLessThan(byDef('review')!.startedSeq);
    expect(byDef('work')!.startedSeq).toBeLessThan(byDef('side')!.startedSeq);
    const review = tiers(s).find((t) => t.stepDefId === 'review');
    expect(review?.out).toMatchObject({
      model: 'opus',
      effort: 'high',
      sources: { effort: 'author' },
    });
    expect(review?.reasons.join('; ')).toMatch(/reviewer raised to the author: effort low < high/);
  });
});
