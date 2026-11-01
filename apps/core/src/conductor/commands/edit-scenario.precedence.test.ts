import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { processCommand } from '../commands.ts';
import {
  envelope,
  forkOfFeature,
  homeTask,
  HUMAN_PROOF,
  LOGIN,
} from '../scenario/__fixtures__/scenario-harness.ts';
import { presetStep, resolveScenario, scenarioPrecedence } from '../scenario/index.ts';

/**
 * P80 (класс `precedence`) + G12: правка сценария пишет ОДНО решение старшинства новой версии
 * поверх файлов проекта — то же, что дают входы оценки и деления над теми же данными; рискованная
 * правка (выкинутый шаг проверки, поднятый предел кругов) — одно предупреждение в исходе, повтор
 * того же `cmdId` второго не даёт, правка исполняется.
 */

const open: LiveTask[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.close();
});

/** Репозиторий с файлом проекта уровня 4: одно сужение и одно расширение (оно отвергается). */
function repoWithProjectFile(): string {
  const repo = tempDir('repo-');
  mkdirSync(join(repo, '.agentdeck'), { recursive: true });
  writeFileSync(
    join(repo, '.agentdeck', 'scenario.json'),
    JSON.stringify({ v: 1, steps: { work: { roundCap: 1 }, review: { roundCap: 9 } } }),
  );
  return repo;
}

const withCheck = (s: Scenario): Scenario => ({
  ...s,
  steps: [...s.steps, presetStep('extra-check', 'check', 'Доп. проверка', ['work'])],
});

async function setup() {
  const repo = repoWithProjectFile();
  const got = await homeTask({
    repos: [{ repoKey: 'r1', path: repo, baseRef: 'main' }],
    allowedRoutes: [LOGIN],
    routesSourceLevel: 2,
  });
  open.push(got.task);
  return { ...got, repo };
}

const precedenceLines = (t: LiveTask) =>
  readJournalLines(t.dir, t.taskId).lines.filter(
    (l): l is JournalLine<'decision'> =>
      l.kind === 'decision' && (l as JournalLine<'decision'>).data.class === 'precedence',
  );

describe('precedence decision from every entry (P80)', () => {
  it('edit-scenario journals the same precedence decision the estimate and split inputs resolve to', async () => {
    const { task: t, env, libraryDir, repo } = await setup();
    const edit = forkOfFeature('team-flow', 1, withCheck);
    const got = await processCommand(
      t,
      envelope(t, 'edit-scenario', { scenario: edit, baseVersion: 1, applyNow: false }),
      HUMAN_PROOF,
      env,
    );
    expect(got.status).toBe('applied');
    const lines = precedenceLines(t);
    expect(lines).toHaveLength(1);
    const journaled = lines[0]?.data;
    // Вход оценки: закреплённые репозитории `{repoKey, path}`; вход деления: `task.created.repos`.
    const allowed = { routes: [LOGIN], level: 2 };
    const roads = {
      estimate: await resolveScenario(
        { id: 'team-flow', version: 1 },
        [{ repoKey: 'r1', path: repo }],
        {
          libraryDir,
        },
      ),
      split: await resolveScenario({ id: 'team-flow', version: 1 }, t.state.created?.repos ?? [], {
        libraryDir,
      }),
    };
    for (const [road, resolution] of Object.entries(roads)) {
      if (!resolution.ok) throw new Error(`${road} did not resolve`);
      const data = scenarioPrecedence(resolution, allowed);
      expect({ road, output: data.output, reasons: data.reasons }).toEqual({
        road,
        output: journaled?.output,
        reasons: journaled?.reasons,
      });
    }
    // Само решение: сужение уровня 4 принято, расширение отвергнуто и названо файлом.
    const keys = (
      journaled?.output as { keys: { key: string; value: unknown; rejected: unknown[] }[] }
    ).keys;
    expect(keys.find((k) => k.key === 'steps.work.roundCap')).toMatchObject({
      value: 1,
      rejected: [],
    });
    expect(keys.find((k) => k.key === 'steps.review.roundCap')?.rejected).toEqual([
      expect.objectContaining({ level: 4, source: 'r1: .agentdeck/scenario.json' }),
    ]);
    expect(keys.find((k) => k.key === 'routes')).toMatchObject({ value: [LOGIN], sourceLevel: 2 });
  });
});

describe('risky live decision: one warning, then obeyed (06:8-9, G12)', () => {
  it('edit-scenario dropping a check step and raising roundCap warns once per cmdId', async () => {
    const { task: t, env } = await setup();
    const first = await processCommand(
      t,
      envelope(t, 'edit-scenario', {
        scenario: forkOfFeature('team-flow', 1, withCheck),
        baseVersion: 1,
        applyNow: false,
      }),
      HUMAN_PROOF,
      env,
    );
    expect(first.status).toBe('applied');
    expect((first.outcome as { warnings?: string[] }).warnings).toBeUndefined();
    const risky = forkOfFeature('team-flow', 2, (s) => ({
      ...s,
      steps: s.steps.map((st) => (st.id === 'review' ? { ...st, roundCap: 5 } : st)),
    }));
    const cmdId = newId();
    const body = envelope(
      t,
      'edit-scenario',
      { scenario: risky, baseVersion: 1, applyNow: false },
      cmdId,
    );
    const second = await processCommand(t, body, HUMAN_PROOF, env);
    expect(second.status).toBe('applied');
    expect((second.outcome as { warnings: string[] }).warnings).toEqual([
      'step review raises roundCap 2 → 5',
      'drops check step extra-check',
    ]);
    const again = await processCommand(t, body, HUMAN_PROOF, env);
    expect(again.outcome).toEqual(second.outcome);
    const applied = readJournalLines(t.dir, t.taskId).lines.filter(
      (l) => l.kind === 'command.applied' && l.cmdId === cmdId,
    );
    expect(applied).toHaveLength(1);
    // Исполнено: новая версия — правка задачи.
    expect(t.state.scenario?.pending?.to).toEqual({ id: 'team-flow', version: 2 });
  });
});
