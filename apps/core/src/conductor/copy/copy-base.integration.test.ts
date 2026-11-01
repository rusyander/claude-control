import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOLO_UNIT, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { installer, makeRepo, taskWithUnit, wiring } from './__fixtures__/copy-harness.ts';
import { pinnedBaseOf, unitCopyOf } from './index.ts';

/**
 * Основа ветки копии (02:73, G19) на настоящем git: единица с предшественником в том же
 * репозитории растёт от его ветки (правки предшественника уже в её копии), без предшественника —
 * от приколотой базы задачи; основа закрепляется sha первой попытки.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8',
  }).trim();

describe('copy branch base (G19)', () => {
  it('a unit after a same-repo predecessor grows from its branch; a unit without one from the pinned task base', async () => {
    const { repo, base } = makeRepo();
    const { task, unitId: first } = await taskWithUnit(repo, base);
    const second = newId();
    task.append({
      kind: 'unit.created',
      actor: 'core',
      unitId: second,
      data: {
        unitId: second,
        repoKey: 'r1',
        branch: `agentdeck/${second.slice(-8)}`,
        ownedPaths: [],
        ...SOLO_UNIT,
        after: [first],
      },
    });
    const w = wiring(task, tempDir('cp-base-'), installer().install);

    const a = await w.prepare(task.taskId, first);
    expect('value' in a).toBe(true);
    const aDir = unitCopyOf(task, first)!.dir;
    expect(pinnedBaseOf(task, first)).toBe(base);
    expect(existsSync(join(aDir, 'later.txt'))).toBe(false);
    writeFileSync(join(aDir, 'contract.txt'), 'from the predecessor\n');
    git(aDir, 'add', 'contract.txt');
    git(aDir, 'commit', '-qm', 'contract');
    const aHead = git(aDir, 'rev-parse', 'HEAD');

    const b = await w.prepare(task.taskId, second);
    expect('value' in b).toBe(true);
    const bDir = unitCopyOf(task, second)!.dir;
    expect(pinnedBaseOf(task, second)).toBe(aHead);
    expect(git(bDir, 'rev-parse', 'HEAD')).toBe(aHead);
    expect(existsSync(join(bDir, 'contract.txt'))).toBe(true);
    task.close();
  }, 120_000);
});
