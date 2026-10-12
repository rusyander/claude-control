import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Проводка E1 в настоящем запуске: прогон в копии получает ОДИН файл
 * `--settings`, где исключения источника, переписанные на копию, стоят рядом
 * с исключением личного `CLAUDE.md`. Подменён только `spawn` — аргументы и
 * файл читаются ровно такими, какими их получил бы CLI.
 */

class FakeChild extends EventEmitter {
  readonly stdin = Object.assign(new EventEmitter(), {
    write: (): boolean => true,
    end: () => undefined,
  });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

interface Seen {
  args: string[];
  settings: string[];
}

async function launch(cwd: string, configDir: string, platformArgs: string[]): Promise<Seen> {
  const seen: Seen = { args: [], settings: [] };
  vi.resetModules();
  vi.doMock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:child_process')>()),
    spawn: (_command: string, args: string[]) => {
      seen.args = args;
      args.forEach((arg, index) => {
        if (arg !== '--settings') return;
        const path = (args[index + 1] ?? '').replace(/^"|"$/g, '');
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { claudeMdExcludes: string[] };
        seen.settings.push(...parsed.claudeMdExcludes);
      });
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    },
  }));
  const { ChatRun } = await import('./ChatRunner.ts');
  await new ChatRun().start({ prompt: 'ok', cwd, configDir, platformArgs }, () => undefined);
  return seen;
}

describe('ChatRunner: прогон в копии исключает то же, что источник', () => {
  let base: string;
  let repo: string;
  let copy: string;
  let config: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' });

  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-runner-parity-')));
    repo = join(base, 'proj');
    copy = join(base, 'proj-worktrees', 'x');
    config = join(base, 'config');
    mkdirSync(repo);
    mkdirSync(config);
    writeFileSync(join(repo, 'CLAUDE.md'), '# team\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'p@example.com');
    git(repo, 'config', 'user.name', 'p');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'one');
    git(repo, 'worktree', 'add', '-q', '-b', 'feat', copy);
    writeFileSync(
      join(config, 'settings.json'),
      JSON.stringify({ claudeMdExcludes: ['**/proj/CLAUDE.md'] }),
    );
  });

  afterEach(() => {
    vi.doUnmock('node:child_process');
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('копия: переписанный шаблон источника едет в --settings', async () => {
    const seen = await launch(copy, config, []);
    expect(seen.settings).toContain(`${copy.replaceAll('\\', '/')}/CLAUDE.md`);
  });

  it('основной чекаут: исключать нечего — флага --settings нет', async () => {
    const seen = await launch(repo, config, []);
    expect(seen.args).not.toContain('--settings');
  });

  it('снятый личный слой: один файл, личный CLAUDE.md и исключения копии вместе', async () => {
    mkdirSync(join(copy, '.claude'));
    writeFileSync(
      join(copy, '.claude', 'settings.local.json'),
      JSON.stringify({ claudeMdExcludes: ['**/proj/CLAUDE.md'] }),
    );
    const seen = await launch(copy, config, ['--setting-sources', 'project,local']);
    expect(seen.args.filter((arg) => arg === '--settings')).toHaveLength(1);
    expect(seen.settings).toContain(`${copy.replaceAll('\\', '/')}/CLAUDE.md`);
    expect(seen.settings).toContain(`${config.replaceAll('\\', '/')}/CLAUDE.md`);
  });
});
