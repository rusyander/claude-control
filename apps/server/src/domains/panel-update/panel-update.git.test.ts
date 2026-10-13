import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPanelUpdate,
  FETCH_EVERY_MS,
  readPanelUpdate,
  resetPanelUpdateMemo,
  type PanelUpdateDeps,
} from './panel-update.ts';

/**
 * Обновление панели поверх НАСТОЯЩЕГО git: голый «origin», клон панели и второй
 * клон, из которого выходят новые коммиты. Подменена только установка
 * зависимостей (`pnpm install` в пустом каталоге — это сеть), git — настоящий:
 * вопрос именно в том, что он сделает с рабочей копией человека.
 */

let base: string;
let origin: string;
let panel: string;
let other: string;

const run = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'core.quotepath=off', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });

const put = (dir: string, path: string, text: string): void => {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
};

const commit = (dir: string, message: string): void => {
  run(dir, ['add', '-A']);
  run(dir, ['commit', '-q', '-m', message]);
};

const head = (dir: string): string => run(dir, ['rev-parse', 'HEAD']).trim();

const entry = (title: string): string =>
  JSON.stringify({ title: { ru: title }, items: [{ kind: 'added', text: { ru: 'пункт' } }] });

/** Из второго клона выходят два коммита: описание и новый lock-файл. */
const publishUpstream = (): void => {
  put(other, 'changelog/entries/2026-10-13-update.json', entry('Кнопка обновления'));
  commit(other, 'feat: кнопка обновления');
  put(other, 'pnpm-lock.yaml', 'lockfileVersion: 2\n');
  commit(other, 'chore: зависимости');
  run(other, ['push', '-q', 'origin', 'main']);
};

const install = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
const deps = (extra: PanelUpdateDeps = {}): PanelUpdateDeps => ({
  install,
  watched: () => true,
  ...extra,
});

beforeEach(() => {
  resetPanelUpdateMemo();
  install.mockClear();
  base = mkdtempSync(join(tmpdir(), 'cc-panel-update-'));
  origin = join(base, 'origin.git');
  panel = join(base, 'panel');
  other = join(base, 'other');
  run(base, ['init', '-q', '--bare', '-b', 'main', origin]);
  run(base, ['clone', '-q', origin, other]);
  run(other, ['checkout', '-q', '-b', 'main']);
  put(other, 'README.md', 'панель\n');
  put(other, 'pnpm-lock.yaml', 'lockfileVersion: 1\n');
  commit(other, 'init');
  run(other, ['push', '-q', '-u', 'origin', 'main']);
  run(base, ['clone', '-q', origin, panel]);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('readPanelUpdate на настоящем репозитории', () => {
  it('свежий клон — новых коммитов нет', async () => {
    const status = await readPanelUpdate(panel, { refresh: true }, deps());
    expect(status).toMatchObject({
      state: 'current',
      branch: 'main',
      upstream: 'origin/main',
      behind: 0,
      ahead: 0,
      incoming: [],
      dirty: [],
    });
    expect(status.fetchedAt).toBeDefined();
  });

  it('вышедшие коммиты видны после fetch: число, темы, описания и новый lock-файл', async () => {
    publishUpstream();
    const status = await readPanelUpdate(panel, { refresh: true }, deps());
    expect(status.state).toBe('behind');
    expect(status.behind).toBe(2);
    expect(status.incoming.map((item) => item.subject)).toEqual([
      'chore: зависимости',
      'feat: кнопка обновления',
    ]);
    expect(status.entries).toEqual([
      { id: '2026-10-13-update', title: { ru: 'Кнопка обновления' } },
    ]);
    expect(status.lockChanged).toBe(true);
  });

  it('без refresh fetch идёт не чаще раза в FETCH_EVERY_MS', async () => {
    let now = 1_000_000;
    const clock = deps({ now: () => now });
    await readPanelUpdate(panel, {}, clock);
    publishUpstream();
    expect((await readPanelUpdate(panel, {}, clock)).behind).toBe(0);
    now += FETCH_EVERY_MS;
    expect((await readPanelUpdate(panel, {}, clock)).behind).toBe(2);
  });

  it('упавший fetch назван, а состояние считается по прежнему снимку', async () => {
    run(panel, ['remote', 'set-url', 'origin', join(base, 'нет-такого.git')]);
    const status = await readPanelUpdate(panel, { refresh: true }, deps());
    expect(status.state).toBe('current');
    expect(status.fetchError).toBeTruthy();
  });

  it('свои и чужие коммиты сразу — «разошлись»', async () => {
    publishUpstream();
    put(panel, 'local.txt', 'свой\n');
    commit(panel, 'свой коммит');
    const status = await readPanelUpdate(panel, { refresh: true }, deps());
    expect(status).toMatchObject({ state: 'diverged', ahead: 1, behind: 2 });
  });

  it('не клон git и ветка без отслеживаемой', async () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    expect((await readPanelUpdate(plain, {}, deps())).state).toBe('not-git');
    run(panel, ['checkout', '-q', '-b', 'local-only']);
    expect(await readPanelUpdate(panel, {}, deps())).toMatchObject({
      state: 'no-upstream',
      branch: 'local-only',
    });
  });
});

describe('applyPanelUpdate на настоящем репозитории', () => {
  it('перематывает на вышедшие коммиты и ставит зависимости при новом lock-файле', async () => {
    publishUpstream();
    const result = await applyPanelUpdate(panel, deps());
    expect(result).toMatchObject({ ok: true, installed: true, watched: true });
    expect(result.to).toBe(head(other));
    expect(head(panel)).toBe(head(other));
    expect(readFileSync(join(panel, 'pnpm-lock.yaml'), 'utf8')).toBe('lockfileVersion: 2\n');
    expect(install).toHaveBeenCalledTimes(1);
    expect(result.status.state).toBe('current');
  });

  it('без нового lock-файла зависимости не ставятся', async () => {
    put(other, 'README.md', 'панель 2\n');
    commit(other, 'docs');
    run(other, ['push', '-q', 'origin', 'main']);
    const result = await applyPanelUpdate(panel, deps());
    expect(result.ok).toBe(true);
    expect(result.installed).toBeUndefined();
    expect(install).not.toHaveBeenCalled();
  });

  it('правки человека в отслеживаемом файле — отказ, файл и HEAD не тронуты', async () => {
    publishUpstream();
    put(panel, 'README.md', 'моя правка\n');
    const before = head(panel);
    const result = await applyPanelUpdate(panel, deps());
    expect(result).toMatchObject({ ok: false, error: 'dirty' });
    expect(result.status.dirty).toEqual(['README.md']);
    expect(head(panel)).toBe(before);
    expect(readFileSync(join(panel, 'README.md'), 'utf8')).toBe('моя правка\n');
  });

  it('новый неотслеживаемый файл с тем же именем — отказ git назван, файл цел', async () => {
    publishUpstream();
    put(panel, 'changelog/entries/2026-10-13-update.json', 'мой черновик');
    const before = head(panel);
    const result = await applyPanelUpdate(panel, deps());
    expect(result).toMatchObject({ ok: false, error: 'pull-failed' });
    expect(result.detail).toBeTruthy();
    expect(head(panel)).toBe(before);
    expect(readFileSync(join(panel, 'changelog/entries/2026-10-13-update.json'), 'utf8')).toBe(
      'мой черновик',
    );
  });

  it('разошедшиеся ветки и «уже последняя» — отказ без перемотки', async () => {
    expect(await applyPanelUpdate(panel, deps())).toMatchObject({ ok: false, error: 'current' });
    publishUpstream();
    put(panel, 'local.txt', 'свой\n');
    commit(panel, 'свой коммит');
    const before = head(panel);
    expect(await applyPanelUpdate(panel, deps())).toMatchObject({ ok: false, error: 'diverged' });
    expect(head(panel)).toBe(before);
  });

  it('упавшая установка зависимостей — код обновлён, ошибка pnpm названа', async () => {
    publishUpstream();
    const failing = vi.fn(async () => ({ code: 1, stdout: 'ERR_PNPM_X boom', stderr: '' }));
    const result = await applyPanelUpdate(panel, deps({ install: failing }));
    expect(result).toMatchObject({ ok: true, installed: false, installError: 'ERR_PNPM_X boom' });
    expect(head(panel)).toBe(head(other));
  });

  it('второе обновление, пока идёт первое, — «уже идёт»', async () => {
    publishUpstream();
    const first = applyPanelUpdate(panel, deps());
    const second = await applyPanelUpdate(panel, deps());
    expect(second).toMatchObject({ ok: false, error: 'busy' });
    expect((await first).ok).toBe(true);
  });
});
