import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitSync, gitSyncOutcome } from './exec.ts';

/**
 * Синхронный запуск git: ПОЧЕМУ ответа нет.
 *
 * Раньше три разные беды приходили одним `undefined`, и вызывающие называли
 * человеку первую попавшуюся: вышедший срок читался как «каталог не репозиторий
 * или такой ветки нет». Разница не косметическая — «не репозиторий» человек
 * чинит, а срок на большом дереве под антивирусом не чинит никак, и искать там
 * нечего.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-git-exec-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const init = (): void => {
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore', windowsHide: true });
};

describe('gitSyncOutcome', () => {
  it('удача отдаёт вывод git', () => {
    init();
    const outcome = gitSyncOutcome(root, ['rev-parse', '--is-inside-work-tree']);

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.stdout.trim()).toBe('true');
  });

  it('не репозиторий — отказ git, а не срок', () => {
    const outcome = gitSyncOutcome(root, ['status', '--porcelain']);

    expect(outcome).toEqual({ ok: false, reason: 'failed' });
  });

  it('вышедший срок назван сроком', () => {
    // Миллисекунды не хватит даже на запуск процесса, поэтому случай
    // воспроизводится всегда — в отличие от того, как он ловился раньше:
    // случайным покраснением гейта под нагрузкой.
    init();
    const outcome = gitSyncOutcome(root, ['status', '--porcelain'], 1);

    expect(outcome).toEqual({ ok: false, reason: 'timeout' });
  });
});

describe('gitSync поверх него', () => {
  it('любая беда остаётся одним `undefined` — прежние вызывающие не тронуты', () => {
    init();

    expect(gitSync(root, ['status', '--porcelain'], 1)).toBeUndefined();
    expect(gitSync(join(root, 'нет-такого'), ['status'])).toBeUndefined();
    expect(gitSync(root, ['rev-parse', '--is-inside-work-tree'])?.trim()).toBe('true');
  });
});
