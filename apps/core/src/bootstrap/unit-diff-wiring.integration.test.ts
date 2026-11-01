import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  installer,
  makeRepo,
  taskWithUnit,
  wiring,
} from '../conductor/copy/__fixtures__/copy-harness.ts';
import { seedSession, toolDeps } from '../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../conductor/model-tools/binding.ts';
import { handleModelTool, TOOL_NOT_IN_PLAN } from '../conductor/model-tools/model-tools.ts';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../journal/resume.ts';
import { unitDiffFacts, unitDiffWiring } from './unit-diff-wiring.ts';

function gitIn(cwd: string, ...args: string[]): void {
  // Автор задан явно: в контейнере Linux глобального имени нет, `commit` без него падает.
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    stdio: 'pipe',
  });
}

/**
 * `unit_diff` по настоящему пути: настоящий git, копия единицы выложена `copyWiring` (вход
 * дирижёра) на закреплённую базу, вызов идёт через `handleModelTool` с чтениями загрузки. Подменён
 * только установщик пакетов (внешняя граница: сеть реестра).
 */

const deps = { ...toolDeps(), unitDiff: unitDiffFacts };

async function reviewOf(task: LiveTask, unitId: string, stepKind = 'review') {
  const seeded = seedSession(task, { stepKind, unitId });
  const bound = bindingOf(task, seeded.sessionId);
  if (!('binding' in bound)) throw new Error(bound.reason);
  return bound.binding;
}

const call = (task: LiveTask, b: Awaited<ReturnType<typeof reviewOf>>, input: unknown) =>
  handleModelTool(task, b, 'unit_diff', input, deps);

describe('unit_diff over a real unit copy', () => {
  it('a changed file returns its diff from the pinned base; untracked, unchanged and foreign files are told apart', async () => {
    const { repo, base } = makeRepo({ 'src/a.ts': 'one\n' });
    const { task, unitId } = await taskWithUnit(repo, base);
    const got = await wiring(task, tempDir('udw-'), installer().install).prepare(
      task.taskId,
      unitId,
    );
    if (!('value' in got) || !got.value.placed) throw new Error(JSON.stringify(got));
    const dir = got.value.placed.dir;
    writeFileSync(join(dir, 'src', 'a.ts'), 'two\n');
    mkdirSync(join(dir, 'src', 'new'), { recursive: true });
    writeFileSync(join(dir, 'src', 'new', 'b.ts'), 'fresh\n');
    const b = await reviewOf(task, unitId);

    const changed = await call(task, b, { file: 'src/a.ts' });
    expect(changed).toMatchObject({ ok: true, result: { file: 'src/a.ts', cut: 0 } });
    const diff = (changed as { result: { diff: string } }).result.diff;
    expect(diff).toContain('-one');
    expect(diff).toContain('+two');

    // Новый неотслеживаемый: тела у git нет — так и сказано, а не пустой дифф.
    const fresh = await call(task, b, { file: './src/new/b.ts' });
    expect((fresh as { result: { diff: string } }).result.diff).toContain('no git body');

    // Файл базы без правки и файл вне репозитория — не дифф единицы.
    expect(await call(task, b, { file: 'package.json' })).toMatchObject({
      ok: false,
      code: 'not-in-unit',
    });
    // Плохие поля — отказ схемы контракта с полями.
    expect(await call(task, b, { path: 'src/a.ts' })).toMatchObject({
      ok: false,
      code: 'invalid',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'unknown-field' })]),
    });
  });

  it('the base branch moving after the copy changes nothing: unit_diff diffs from the pinned sha, a session secret in the body is masked', async () => {
    const { repo } = makeRepo({ 'src/a.ts': 'one\n' });
    const { task, unitId } = await taskWithUnit(repo, 'main');
    const got = await wiring(task, tempDir('udw-'), installer().install).prepare(
      task.taskId,
      unitId,
    );
    if (!('value' in got) || !got.value.placed) throw new Error(JSON.stringify(got));
    const dir = got.value.placed.dir;
    // Ветка базы ушла вперёд после копии: чужая правка a.ts и новый файл c.ts.
    writeFileSync(join(repo, 'src', 'a.ts'), 'moved on main\n');
    writeFileSync(join(repo, 'src', 'c.ts'), 'main only\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'C');
    const secret = 'plainsessionvalue0123456789';
    writeFileSync(join(dir, 'src', 'a.ts'), `two ${secret}\n`);
    const b = await reviewOf(task, unitId);
    const masked = { ...toolDeps(), unitDiff: unitDiffWiring(() => [secret]) };

    const changed = await handleModelTool(task, b, 'unit_diff', { file: 'src/a.ts' }, masked);
    const diff = (changed as { result: { diff: string; masked: number } }).result;
    expect(diff.diff).toContain('-one');
    expect(diff.diff).not.toContain('moved on main');
    expect(diff.diff).not.toContain(secret);
    expect(diff.masked).toBeGreaterThan(0);
    // Файл, что есть только в ушедшей ветке, — не правка единицы.
    expect(await call(task, b, { file: 'src/c.ts' })).toMatchObject({
      ok: false,
      code: 'not-in-unit',
    });
  });

  it('only review and answer-reviewers get the tool; a unit without a copy is refused, not read from the repo folder', async () => {
    const { repo, base } = makeRepo({ 'src/a.ts': 'one\n' });
    const { task, unitId } = await taskWithUnit(repo, base);
    // Правка в папке репозитория человека: без копии единицы её никто не должен показать.
    writeFileSync(join(repo, 'src', 'a.ts'), 'human edit\n');

    const work = await reviewOf(task, unitId, 'work');
    expect(await call(task, work, { file: 'src/a.ts' })).toMatchObject({
      ok: false,
      code: TOOL_NOT_IN_PLAN,
    });
    const answer = await reviewOf(task, unitId, 'answer-reviewers');
    expect(await call(task, answer, { file: 'src/a.ts' })).toMatchObject({
      ok: false,
      code: 'unknown',
      message: expect.stringContaining('has no copy'),
    });
  });
});
