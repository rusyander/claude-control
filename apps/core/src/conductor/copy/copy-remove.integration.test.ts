import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { removeVerified } from '../../platform/safe-io/remove.ts';
import { git, installer, makeRepo, taskWithUnit, wiring } from './__fixtures__/copy-harness.ts';

/**
 * Снятие копии единицы по настоящему пути (01 §Resources, P26): снимается только своя копия
 * задачи (запись ресурса этой единицы), отслеживаемые правки — работа агента, даже под списком
 * зеркала и под именем lock-файла, а «снято» — по чтению назад и с закрытой записью ресурса.
 */

async function placed(
  tracked: Record<string, string> = {},
  mainEdits: Record<string, string> = {},
) {
  const { repo, base } = makeRepo(tracked);
  for (const [path, text] of Object.entries(mainEdits)) writeFileSync(join(repo, path), text);
  const { task, unitId, branch } = await taskWithUnit(repo, base);
  const root = tempDir('cpw-');
  const w = wiring(task, root, installer().install);
  const got = await w.prepare(task.taskId, unitId);
  if (!('value' in got) || !got.value.placed) throw new Error('prepare unread');
  return { repo, task, unitId, branch, root, w, dir: got.value.placed.dir };
}

describe('unit copy removal', () => {
  it('a worktree that is not this unit’s copy is refused, never removed', async () => {
    const { repo, task, unitId, w } = await placed();
    const human = join(tempDir('hwt-'), 'human-wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'human/feature', human);
    writeFileSync(join(human, 'notes.local.md'), 'my notes\n');
    const got = await w.remove(task.taskId, unitId, { repo, dir: human, branch: 'human/feature' });
    expect(got).toMatchObject({
      ok: false,
      refused: expect.stringContaining('not a copy of unit'),
    });
    expect(readFileSync(join(human, 'notes.local.md'), 'utf8')).toBe('my notes\n');
    task.close();
  });

  it('tracked edits under the mirror list or named like a lock file are work; mirrored main edits are not', async () => {
    const { repo, task, unitId, branch, dir, w } = await placed(
      { '.claude/rules.md': 'v1\n', '.claude/settings.json': '{}\n' },
      { '.claude/settings.json': '{"from":"main"}\n' },
    );
    // Правка человека в основной копии пришла зеркалом — это слой ядра, не работа.
    expect(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).toBe('{"from":"main"}\n');
    writeFileSync(join(dir, '.claude', 'rules.md'), 'agent rule\n');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'agent lock update\n');
    const refused = await w.remove(task.taskId, unitId, { repo, dir, branch });
    expect(refused).toEqual({
      ok: false,
      refused: 'uncommitted work in the copy: .claude/rules.md, pnpm-lock.yaml',
    });
    expect(existsSync(dir)).toBe(true);
    git(dir, 'checkout', '--', '.claude/rules.md', 'pnpm-lock.yaml');
    expect(await w.remove(task.taskId, unitId, { repo, dir, branch })).toMatchObject({ ok: true });
    expect(existsSync(dir)).toBe(false);
    task.close();
  });

  it('a copy whose dir is already gone is pruned from git and its resource closed by read-back', async () => {
    const { repo, task, unitId, branch, dir, w } = await placed();
    expect(removeVerified(dir).removed).toBe(true);
    const got = await w.remove(task.taskId, unitId, { repo, dir, branch });
    expect(got).toMatchObject({ ok: true, verified: expect.stringContaining('not listed') });
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(branch);
    const copy = Object.values(task.state.resources).find((r) => r.kind === 'copy');
    expect(copy?.status).toBe('verified');
    task.close();
  });
});
