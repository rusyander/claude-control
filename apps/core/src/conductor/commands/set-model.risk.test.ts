import { afterEach, describe, expect, it } from 'vitest';
import { SOLO_UNIT } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { ModelRank } from '../../policy/resolve/risky.ts';
import { processCommand } from '../commands.ts';
import {
  envelope,
  homeTask,
  HUMAN_PROOF,
  LOGIN,
} from '../scenario/__fixtures__/scenario-harness.ts';
import type { CommandEnv } from './commands.types.ts';
import { ladderRank } from './set-model.ts';

/**
 * 06:8 + G12: `set-model`, ставящий ревьюеру модель ниже модели автора, исполняется с ОДНИМ
 * предупреждением в исходе; повтор того же `cmdId` возвращает записанный исход, вторая строка
 * `command.applied` не пишется. Ранг неизвестен — предупреждение называет это, а не молчит.
 */

const open: LiveTask[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.close();
});

/** Ранги — та же лестница, что судья `tier` берёт для пола ревьюера; потолок задачи — середина. */
const RANK: ModelRank = ladderRank({
  claude: { models: ['claude-haiku-4', 'claude-sonnet-5', 'claude-opus-5'], efforts: [] },
});

function startStep(t: LiveTask, unitId: string, stepKind: 'work' | 'review' | 'custom'): string {
  const stepId = newId();
  t.append({
    kind: 'step.started',
    actor: 'core',
    unitId,
    stepId,
    data: {
      stepId,
      unitId,
      stepKind,
      stepDefId: stepKind,
      round: 0,
      scenario: { id: 'feature', version: 1 },
      budgetMs: 0,
    },
  });
  return stepId;
}

/** Единица: шаг работы (автор), затем идущий шаг ревью. */
async function task() {
  const got = await homeTask({ allowedRoutes: [LOGIN], modelCeiling: 'claude-sonnet-5' });
  open.push(got.task);
  const unitId = newId();
  got.task.append({
    kind: 'unit.created',
    actor: 'core',
    unitId,
    data: { unitId, repoKey: 'r1', branch: 'b', ownedPaths: [], ...SOLO_UNIT },
  });
  const author = startStep(got.task, unitId, 'work');
  const review = startStep(got.task, unitId, 'review');
  return { ...got, review, author };
}

const ranked = (env: CommandEnv, modelRank?: ModelRank): CommandEnv =>
  Object.assign(Object.create(null) as object, env, { modelRank }) as CommandEnv;

const setReviewModel = (t: LiveTask, review: string, model: string, cmdId?: string) =>
  envelope(
    t,
    'set-model',
    { scope: 'step', scopeId: review, model, effort: 'high', timing: 'safe-point' },
    cmdId,
  );

describe('set-model risky pair: reviewer below author (06:8, G12)', () => {
  it('a reviewer model ranked below the author warns once; the same cmdId replays the stored outcome', async () => {
    const { task: t, env, review, author } = await task();
    const cmdId = newId();
    const body = setReviewModel(t, review, 'claude-haiku-4', cmdId);
    const first = await processCommand(t, body, HUMAN_PROOF, ranked(env, RANK));
    expect(first.status).toBe('applied');
    expect((first.outcome as { warnings: string[] }).warnings).toEqual([
      `review step ${review} (claude/claude-haiku-4) vs its author step ${author} (claude/claude-sonnet-5): the reviewer model ranks below the author model`,
    ]);
    const again = await processCommand(t, body, HUMAN_PROOF, ranked(env, RANK));
    expect(again.outcome).toEqual(first.outcome);
    const applied = readJournalLines(t.dir, t.taskId).lines.filter(
      (l) => l.kind === 'command.applied' && l.cmdId === cmdId,
    );
    expect(applied).toHaveLength(1);
    // Исполнено: правка легла строками `override.set`.
    expect(t.state.overrides.map((o) => [o.scopeId, o.field, o.value])).toEqual([
      [review, 'model', 'claude-haiku-4'],
      [review, 'effort', 'high'],
    ]);
  });

  it('a reviewer raised above the author applies without warnings', async () => {
    const { task: t, env, review } = await task();
    const got = await processCommand(
      t,
      setReviewModel(t, review, 'claude-opus-5'),
      HUMAN_PROOF,
      ranked(env, RANK),
    );
    expect(got.status).toBe('applied');
    expect(got.outcome).not.toHaveProperty('warnings');
  });

  it('the author is the same as the tier reviewer floor uses: a unit with only a custom step warns against it; beside a work step the work step is the author', async () => {
    // Только свой шаг пишет код — он автор (общее правило `reviewAuthorOf`, как у пола ревьюера).
    const solo = await homeTask({ allowedRoutes: [LOGIN], modelCeiling: 'claude-sonnet-5' });
    open.push(solo.task);
    const unitId = newId();
    solo.task.append({
      kind: 'unit.created',
      actor: 'core',
      unitId,
      data: { unitId, repoKey: 'r1', branch: 'b', ownedPaths: [], ...SOLO_UNIT },
    });
    const custom = startStep(solo.task, unitId, 'custom');
    const review = startStep(solo.task, unitId, 'review');
    const got = await processCommand(
      solo.task,
      setReviewModel(solo.task, review, 'claude-haiku-4'),
      HUMAN_PROOF,
      ranked(solo.env, RANK),
    );
    expect((got.outcome as { warnings: string[] }).warnings).toEqual([
      expect.stringContaining(`vs its author step ${custom} (claude/claude-sonnet-5)`),
    ]);
    // Свой шаг рядом с работой, начатый позже неё, автором не становится: пара — с работой.
    const { task: t, env, author } = await task();
    const unit = t.state.steps[author]!.unitId;
    const side = startStep(t, unit, 'custom');
    const late = startStep(t, unit, 'review');
    const pair = await processCommand(
      t,
      setReviewModel(t, late, 'claude-haiku-4'),
      HUMAN_PROOF,
      ranked(env, RANK),
    );
    const warnings = (pair.outcome as { warnings: string[] }).warnings;
    expect(warnings).toContainEqual(expect.stringContaining(`review step ${late} `));
    expect(warnings.find((w) => w.includes(`review step ${late} `))).toContain(
      `its author step ${author} `,
    );
    expect(warnings.join('\n')).not.toContain(side);
  });

  it('no rank port (or an unknown model): the warning names the unknown rank', async () => {
    const { task: t, env, review } = await task();
    const got = await processCommand(
      t,
      setReviewModel(t, review, 'claude-opus-5'),
      HUMAN_PROOF,
      ranked(env, undefined),
    );
    expect((got.outcome as { warnings: string[] }).warnings).toEqual([
      expect.stringContaining(
        'model rank unknown, cannot confirm the reviewer is not below the author',
      ),
    ]);
  });
});
