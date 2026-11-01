import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { humanHooks } from '../../bootstrap/conductor-wiring/human.ts';
import { openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { statusSnapshot } from '../../platform/git/status.ts';
import { seedSession } from '../model-tools/__fixtures__/seed.ts';
import type { StepCtx } from '../run/run.types.ts';

/**
 * P69 (02 §User interventions, G17) на настоящем git: снимок статуса на конце хода, сверка перед
 * шагом. Правка сессии внутри хода не названа; правка человека между ходами (и того же размера),
 * новый файл и коммит руками (сдвиг HEAD) — строка `copy.changed-externally` и раздел брифа.
 * Непрочитанный статус — «не прочитано», не «правок нет». Неподвинутый файл не перечитывается.
 */

const roots: string[] = [];
afterAll(() => {
  for (const r of roots)
    rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adk-edits-'));
  roots.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore' });
  for (const name of ['a.txt', 'b.txt']) writeFileSync(join(dir, name), `${name} v1\n`);
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  return dir;
}

function changed(task: LiveTask) {
  return readJournalLines(task.dir, task.taskId)
    .lines.filter((l) => l.kind === 'copy.changed-externally')
    .map((l) => (l.data as { files: string[] }).files);
}

async function setup() {
  const { task, taskId } = await openFresh();
  const s = seedSession(task, { stepKind: 'work' });
  const dir = repo();
  const hooks = humanHooks({ registry: { live: () => task }, note: () => {} } as never);
  const ctx: StepCtx = {
    taskId,
    unitId: s.unitId,
    repoKey: 'r1',
    copyDir: dir,
    stepId: s.stepId,
    def: {} as StepCtx['def'],
    round: 0,
    sessionId: s.sessionId,
  };
  return { task, dir, hooks, ctx };
}

describe('P69 manual edits in a copy', () => {
  it('P69 a human edit between turns (same size), a new file and a manual commit are named; the session edit is not', async () => {
    const s = await setup();
    expect((await s.hooks.preStep!(s.ctx)).sections).toEqual([]);
    // Правка самой сессии внутри хода: снимок конца хода её учитывает.
    writeFileSync(join(s.dir, 'a.txt'), 'session edit\n');
    await s.hooks.onTurnEnd!(s.ctx, { seq: 1, hadStepDone: false });
    // Человек между ходами: тот же размер, другое содержимое; новый файл.
    writeFileSync(join(s.dir, 'b.txt'), 'b.txt v2\n');
    writeFileSync(join(s.dir, 'c.txt'), 'new\n');
    const first = await s.hooks.preStep!(s.ctx);
    expect(changed(s.task)).toEqual([['b.txt', 'c.txt']]);
    expect(first.sections).toMatchObject([{ id: 'external-edits' }]);
    expect(first.sections[0]?.text).toContain('- b.txt\n- c.txt');
    expect(first.sections[0]?.text).not.toContain('a.txt');
    // Сверка без новых правок — тишина.
    expect((await s.hooks.preStep!(s.ctx)).sections).toEqual([]);
    git(s.dir, 'add', '-A');
    git(s.dir, '-c', 'user.name=h', '-c', 'user.email=h@h', 'commit', '-q', '-m', 'by hand');
    await s.hooks.preStep!(s.ctx);
    expect(changed(s.task)[1]).toEqual(['HEAD', 'a.txt', 'b.txt', 'c.txt']);
    s.task.close();
  });

  it('P69 an unreadable copy status says unknown in the brief and journals nothing', async () => {
    const s = await setup();
    await s.hooks.preStep!(s.ctx);
    const gone = await s.hooks.preStep!({ ...s.ctx, copyDir: join(s.dir, 'missing') });
    expect(gone.sections).toMatchObject([{ id: 'external-edits' }]);
    expect(gone.sections[0]?.text).toMatch(/^Could not read the copy status/);
    expect(changed(s.task)).toEqual([]);
    s.task.close();
  });

  it('G17 a dirty path whose mtime and size did not move keeps its stamp without a reread', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.txt'), 'dirty\n');
    const first = await statusSnapshot(dir, null);
    if (!('value' in first)) throw new Error(JSON.stringify(first));
    expect(first.value.entries['a.txt']?.stamp).toMatch(/^sha256:/);
    const planted = {
      ...first.value,
      entries: { 'a.txt': { ...first.value.entries['a.txt']!, stamp: 'planted' } },
    };
    const again = await statusSnapshot(dir, planted);
    if (!('value' in again)) throw new Error(JSON.stringify(again));
    expect(again.value.entries['a.txt']?.stamp).toBe('planted');
  });
});
