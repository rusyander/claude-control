import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOLO_UNIT, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { integratedGate, INTEGRATION_ROLE } from '../gates/index.ts';
import { git, installer, makeRepo, taskWithUnit, wiring } from './__fixtures__/copy-harness.ts';
import { INTEGRATION_CONFLICT_SIGNAL, pinnedBaseOf, reviewBaseOf, unitCopyOf } from './index.ts';

/**
 * Копия единицы интеграции (этап 11, W3-18b) на настоящем git: основа — слияние голов обеих
 * параллельных единиц (`merge-tree` + `commit-tree`, без ветки и пуша в источнике), ревьюер видит
 * общий дифф от приколотой базы задачи; конфликт голов — копии нет, файлы названы; закрытая
 * единица интеграции — ворота `integrated` красные. Решение конфликта в задаче —
 * `gates/integration-publish.integration.test.ts`.
 */

function addUnit(task: LiveTask, after: string[], role?: typeof INTEGRATION_ROLE): string {
  const unitId = newId();
  task.append({
    kind: 'unit.created',
    actor: 'core',
    unitId,
    data: {
      unitId,
      repoKey: 'r1',
      branch: `agentdeck/${unitId.slice(-8)}`,
      ownedPaths: [],
      ...SOLO_UNIT,
      after,
      ...(role ? { name: 'integration', role } : {}),
    },
  });
  return unitId;
}

async function commitIn(
  w: ReturnType<typeof wiring>,
  task: LiveTask,
  unitId: string,
  file: string,
  text: string,
): Promise<string> {
  expect('value' in (await w.prepare(task.taskId, unitId))).toBe(true);
  const dir = unitCopyOf(task, unitId)!.dir;
  writeFileSync(join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-qm', `unit ${file}`);
  return git(dir, 'rev-parse', 'HEAD');
}

async function twoUnits(shared: boolean) {
  const { repo, base } = makeRepo({ 'iface.ts': 'export interface Api {}\n' });
  const { task, unitId: a } = await taskWithUnit(repo, base);
  const b = addUnit(task, []);
  const w = wiring(task, tempDir('cp-int-'), installer().install);
  const aHead = await commitIn(
    w,
    task,
    a,
    shared ? 'iface.ts' : 'api.ts',
    'export const api = 1;\n',
  );
  const bHead = await commitIn(
    w,
    task,
    b,
    shared ? 'iface.ts' : 'web.ts',
    'export const web = 2;\n',
  );
  const integ = addUnit(task, [a, b], INTEGRATION_ROLE);
  return { repo, base, task, w, a, b, aHead, bHead, integ };
}

describe('W3-18b integration copy = the merge of the unit heads', () => {
  it('two parallel unit heads → the integration copy holds both, its HEAD has both heads as parents; the review base is the task base', async () => {
    const { repo, base, task, w, aHead, bHead, integ } = await twoUnits(false);
    const branchesBefore = git(repo, 'branch', '--list', '--format=%(refname:short)');
    expect('value' in (await w.prepare(task.taskId, integ))).toBe(true);
    const dir = unitCopyOf(task, integ)!.dir;
    expect(readFileSync(join(dir, 'api.ts'), 'utf8')).toContain('api = 1');
    expect(readFileSync(join(dir, 'web.ts'), 'utf8')).toContain('web = 2');
    const parents = git(dir, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1);
    expect(parents).toEqual([aHead, bHead]);
    expect(pinnedBaseOf(task, integ)).toBe(git(dir, 'rev-parse', 'HEAD'));
    // Ревью идёт по общему диффу: от приколотой базы задачи, не от слияния (тот дифф пуст).
    expect(reviewBaseOf(task, integ)).toBe(base);
    const changed = git(dir, 'diff', '--name-only', `${reviewBaseOf(task, integ)!}...HEAD`);
    expect(changed.split('\n').sort()).toEqual(['api.ts', 'web.ts']);
    // В источнике — только ветка копии интеграции, слияние не двигало ветки единиц и main.
    const branchesAfter = git(repo, 'branch', '--list', '--format=%(refname:short)');
    expect(
      branchesAfter.split('\n').filter((b) => !branchesBefore.split('\n').includes(b)),
    ).toEqual([task.state.units[integ]!.branch]);
    expect(git(repo, 'rev-parse', 'main')).not.toBe(git(dir, 'rev-parse', 'HEAD'));
    expect(integratedGate(task.state, integ)).toBeNull();
    task.close();
  }, 120_000);

  it('a planted conflict (both units edit iface.ts) → no integration copy, the files named, the integrated gate red', async () => {
    const { task, w, a, integ } = await twoUnits(true);
    const got = await w.prepare(task.taskId, integ);
    expect('value' in got && got.value.decision.verdict).toBe('failed');
    expect(unitCopyOf(task, integ)).toBeUndefined();
    const signal = readJournalLines(task.dir, task.taskId).lines.find(
      (l) =>
        l.kind === 'signal' &&
        (l.data as { signal: string }).signal === INTEGRATION_CONFLICT_SIGNAL,
    );
    expect(JSON.parse((signal!.data as { detail: string }).detail).files).toEqual(['iface.ts']);
    // Конфликт держит ворота шага интеграции красными (`gates/integration-hooks.ts`); единица
    // закрывается, когда человек на пределе кругов отвечает «остановить», — ворота красные.
    task.append({
      kind: 'unit.transition',
      actor: 'core',
      unitId: integ,
      data: { unitId: integ, event: 'close', from: 'planned', to: 'closed' },
    });
    expect(integratedGate(task.state, a)).toMatchObject({ kind: 'red' });
    expect(existsSync(join(unitCopyOf(task, a)!.dir, 'iface.ts'))).toBe(true);
    task.close();
  }, 120_000);

  it('a closed unit is not merged: its head never reaches the integration copy, so its conflict does not hold back the units that publish', async () => {
    const { task, w, b, aHead, integ } = await twoUnits(true);
    // Единица B закрылась провалом до интеграции: её ветка не публикуется — в общую проверку не идёт.
    task.append({
      kind: 'unit.transition',
      actor: 'core',
      unitId: b,
      data: { unitId: b, event: 'close', from: 'planned', to: 'closed' },
    });
    const got = await w.prepare(task.taskId, integ);
    expect('value' in got && got.value.decision.verdict).not.toBe('failed');
    const dir = unitCopyOf(task, integ)!.dir;
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(aHead);
    expect(readFileSync(join(dir, 'iface.ts'), 'utf8')).toContain('api = 1');
    const signals = readJournalLines(task.dir, task.taskId).lines.filter(
      (l) =>
        l.kind === 'signal' &&
        (l.data as { signal: string }).signal === INTEGRATION_CONFLICT_SIGNAL,
    );
    expect(signals).toEqual([]);
    task.close();
  }, 120_000);
});
