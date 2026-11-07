import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { tierLadderOf } from '@agentdeck/providers/ladder';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { describe, expect, it } from 'vitest';
import { createRunEconomy } from '../../bootstrap/economy-wiring/continuation.ts';
import { learnedRaiseFor } from '../../bootstrap/economy-wiring/routing-facts.ts';
import { learnedPathsFor, readLearned, type LearnedTable } from '../../economy/learned/index.ts';
import type { TierLadder } from '../../economy/tier.types.ts';
import { WindowBook } from '../../economy/window/index.ts';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { presetStep } from '../scenario/presets.ts';
import { stand, type Script, type Stand } from './__fixtures__/run-harness.ts';

/**
 * Подъём по обучению (этап 11, W2-11, F1, P140) на настоящем пути: десять задач кусочка
 * `mechanical` идут настоящим циклом дирижёра в общий каталог задач, первая попытка части из них
 * красная (`post: red` — вердикт проверки, внешняя граница). Выученное читается настоящим
 * `readLearned` из их журналов; одиннадцатая задача судится `tier` с подъёмом из той же проводки,
 * что у ядра (`learnedRaiseFor`). Подделаны только сессия модели и вердикт проверки.
 */

const LADDERS: Readonly<Record<string, TierLadder>> = {
  claude: tierLadderOf(claudeRunFacts) as TierLadder,
};

const SCENARIO: Scenario = {
  id: 'promotion',
  version: 1,
  title: 't',
  steps: [presetStep('work', 'work', 'Работа', [])],
};

interface TierRow {
  stepId: string;
  round: number;
  out: {
    model: string | null;
    effort: string | null;
    roleSource: string;
    sources: { model: string; effort: string };
    promotion: { rungs: number; evidence: string[] } | null;
  };
  reasons: string[];
}

function tiers(s: Stand): TierRow[] {
  return readJournalLines(s.dir, s.taskId).lines.flatMap((l) => {
    if (l.kind !== 'decision' || !l.stepId) return [];
    const d = (l as JournalLine<'decision'>).data;
    const step = s.task.state.steps[l.stepId];
    if (d.class !== 'tier' || !step) return [];
    return [
      {
        stepId: l.stepId,
        round: step.round,
        out: d.output as unknown as TierRow['out'],
        reasons: d.reasons,
      },
    ];
  });
}

async function run(script: Script, table?: () => LearnedTable | null): Promise<Stand> {
  const economy = createRunEconomy({
    windows: new WindowBook(),
    now: () => 1_000,
    ladders: LADDERS,
    facts: table ? { learnedRaise: learnedRaiseFor({ table }) } : {},
  });
  const s = await stand(
    SCENARIO,
    {
      journalSessions: true,
      modelCeiling: 'opus',
      lead: { profile: 'balanced' },
      unitRole: 'mechanical',
      economy,
      ...script,
    },
    [],
  );
  await s.until((t) => t.state.task === 'done' || t.state.task === 'failed', 10_000);
  await s.stop();
  return s;
}

describe('stage 11 W2-11: learned auto-promotion on the real run path', () => {
  it('stage 11 ten mechanical runs with scripted first-pass failures → the 11th task starts one rung up, source learned-promotion, naming the sample ids', async () => {
    const tasksDir = join(tempDir('promotion-'), 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    const firsts: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      // Красная первая попытка у задач 0, 3, 6, 9: к восьмой пробе — 5/8 первых проходов.
      const s = await run({ tasksDir, ...(i % 3 === 0 ? { post: { 'work:0': 'red' } } : {}) });
      const first = tiers(s).find((t) => t.round === 0);
      expect(first?.out).toMatchObject({ model: 'sonnet', effort: 'high', promotion: null });
      firsts.push(first!.stepId);
      expect(s.task.state.task).toBe('done');
    }
    const got = await readLearned(learnedPathsFor(tasksDir));
    const table = 'value' in got ? got.value : null;
    const probes = Object.values(table?.firstPass ?? {});
    expect(probes).toHaveLength(1);
    expect(probes[0]?.map((p) => p.passed)).toEqual(
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => i % 3 !== 0),
    );

    // Красное до: без подъёма одиннадцатая задача стартует на той же ступени.
    const before = tiers(await run({}))[0];
    expect(before?.out).toMatchObject({ model: 'sonnet', effort: 'high', promotion: null });
    expect(before?.out.sources.effort).not.toBe('learned-promotion');

    const eleventh = tiers(await run({}, () => table))[0];
    expect(eleventh?.out).toMatchObject({
      model: 'sonnet',
      effort: 'xhigh',
      roleSource: 'learned-promotion',
      sources: { effort: 'learned-promotion' },
      promotion: { rungs: 1, evidence: firsts.slice(0, 8) },
    });
    expect(eleventh?.reasons.join('; ')).toContain(
      `learned promotion +1: sonnet·high → sonnet·xhigh (samples ${firsts.slice(0, 8).join(', ')})`,
    );
  }, 60_000);
});
