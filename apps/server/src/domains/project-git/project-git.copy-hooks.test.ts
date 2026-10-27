import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { addWorktree, mirrorWorktree } from './project-git.ts';
import { checkCopyReady, describeGaps, repairCopy } from './copy-readiness.ts';

/**
 * Запись хуков в `settings.local.json` копии (`copy-hooks.ts`) — на НАСТОЯЩЕЙ
 * копии git: скрипты `.claude/hooks` она получает ссылкой, а запись — файлом на
 * день создания. Хук, заведённый в оригинале позже, в копии не срабатывал.
 */

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста это не влияет.
  }
}

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
}

const SETTINGS = join('.claude', 'settings.local.json');

const OLD_HOOK = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/ticket-flow.mjs"' }],
};
const NEW_HOOK = {
  type: 'command',
  command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/gate-tool-guard.mjs"',
  timeout: 10,
};

type Settings = {
  permissions?: { allow?: string[] };
  hooks?: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
};

function readSettings(dir: string): Settings {
  return JSON.parse(readFileSync(join(dir, SETTINGS), 'utf8')) as Settings;
}

function writeSettings(dir: string, data: Settings, mtime?: Date): void {
  writeFileSync(join(dir, SETTINGS), `${JSON.stringify(data, null, 2)}\n`);
  if (mtime) utimesSync(join(dir, SETTINGS), mtime, mtime);
}

function commands(data: Settings): string[] {
  return Object.values(data.hooks ?? {}).flatMap((groups) =>
    groups.flatMap((group) => group.hooks.map((hook) => String(hook.command))),
  );
}

describe.skipIf(!hasGit())('хуки оригинала в settings.local.json копии', () => {
  let dir: string;
  let siblings: string;
  let home: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-hooks-home-'));
    for (const key of ['XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'HOME'] as const) {
      savedEnv[key] = process.env[key];
    }
    process.env.XDG_CONFIG_HOME = home;
    process.env.GIT_CONFIG_GLOBAL = join(home, 'gitconfig');
    writeFileSync(join(home, 'gitconfig'), '');
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-hooks-')));
    siblings = join(dirname(dir), `${basename(dir)}-worktrees`);
    gitIn(dir, 'init', '--initial-branch=main');
    gitIn(dir, 'config', 'user.email', 'test@example.invalid');
    gitIn(dir, 'config', 'user.name', 'Test');
    gitIn(dir, 'config', 'commit.gpgsign', 'false');
    gitIn(dir, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(dir, '.gitignore'), '/.claude/*\n');
    writeFileSync(join(dir, 'file.txt'), 'первый\n');
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-m', 'первый');
    mkdirSync(join(dir, '.claude', 'hooks'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'hooks', 'gate-tool-guard.mjs'), '');
    writeSettings(dir, {
      permissions: { allow: ['Bash(git status)'] },
      hooks: { PreToolUse: [OLD_HOOK] },
    });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    dropTemp(siblings);
    dropTemp(dir);
    dropTemp(home);
  });

  /**
   * Раскладка 27.10: копия создана, в её файле — своё разрешение, и по времени
   * он свежее оригинала; потом в оригинале прописали новый хук.
   */
  async function copyThenNewHook(): Promise<string> {
    const created = await addWorktree(dir, 'feature/hooks');
    const copySettings = readSettings(created.path);
    copySettings.permissions?.allow?.push('Bash(npm test)');
    writeSettings(created.path, copySettings, new Date(Date.now() + 3_600_000));
    writeSettings(dir, {
      permissions: { allow: ['Bash(git status)'] },
      hooks: { PreToolUse: [{ ...OLD_HOOK, hooks: [...OLD_HOOK.hooks, NEW_HOOK] }] },
    });
    return created.path;
  }

  it('хук, прописанный в оригинале после создания копии, — дыра hooks с его именем', async () => {
    const copy = await copyThenNewHook();
    const state = checkCopyReady({ mainDir: dir, copyDir: copy });
    expect(state.ready).toBe(false);
    expect(state.gaps).toEqual([
      {
        kind: 'hooks',
        path: '.claude/settings.local.json',
        names: ['PreToolUse: gate-tool-guard.mjs'],
      },
    ]);
    expect(describeGaps(state.gaps)).toContain('gate-tool-guard.mjs');
  });

  it('добор дописывает только недостающий хук, разрешения копии остаются', async () => {
    const copy = await copyThenNewHook();
    const after = await repairCopy({ mainDir: dir, copyDir: copy });
    expect(after).toMatchObject({ ready: true, gaps: [] });

    const settings = readSettings(copy);
    expect(settings.permissions?.allow).toEqual(['Bash(git status)', 'Bash(npm test)']);
    expect(commands(settings)).toEqual([OLD_HOOK.hooks[0]?.command, NEW_HOOK.command]);
    // Запись легла в группу с тем же matcher и целиком, с таймаутом.
    expect(settings.hooks?.PreToolUse).toHaveLength(1);
    expect(settings.hooks?.PreToolUse?.[0]?.hooks[1]).toEqual(NEW_HOOK);

    // Повторный добор ничего не удваивает.
    await repairCopy({ mainDir: dir, copyDir: copy });
    expect(commands(readSettings(copy))).toHaveLength(2);
  });

  it('хук под новым событием ложится новой группой', async () => {
    const created = await addWorktree(dir, 'feature/stop-hook');
    writeSettings(dir, {
      permissions: { allow: ['Bash(git status)'] },
      hooks: { PreToolUse: [OLD_HOOK], Stop: [{ hooks: [NEW_HOOK] }] },
    });
    utimesSync(join(dir, SETTINGS), new Date(0), new Date(0));
    await repairCopy({ mainDir: dir, copyDir: created.path });
    expect(readSettings(created.path).hooks?.Stop).toEqual([{ hooks: [NEW_HOOK] }]);
  });

  it('дыра одних хуков не переносит заново остальной локальный слой', async () => {
    const copy = await copyThenNewHook();
    mkdirSync(join(copy, '.agent'), { recursive: true });
    mkdirSync(join(dir, '.agent'), { recursive: true });
    writeFileSync(join(copy, '.agent', 'notes.md'), 'записи копии\n');
    utimesSync(join(copy, '.agent', 'notes.md'), new Date(0), new Date(0));
    writeFileSync(join(dir, '.agent', 'notes.md'), 'записи оригинала\n');

    await repairCopy({ mainDir: dir, copyDir: copy });
    expect(readFileSync(join(copy, '.agent', 'notes.md'), 'utf8')).toBe('записи копии\n');
  });

  it('кнопка «Добрать» дописывает хук и при файле копии свежее оригинала', async () => {
    const copy = await copyThenNewHook();
    const result = await mirrorWorktree(dir, copy);
    expect(result.mirror.mirrored).toContain('.claude/settings.local.json');
    expect(commands(readSettings(copy))).toContain(NEW_HOOK.command);
    expect(readSettings(copy).permissions?.allow).toContain('Bash(npm test)');
    expect(checkCopyReady({ mainDir: dir, copyDir: copy }).ready).toBe(true);
  });

  it('лишний хук копии — не дыра: его мог прописать сам агент', async () => {
    const created = await addWorktree(dir, 'feature/own-hook');
    writeSettings(created.path, {
      permissions: { allow: ['Bash(git status)'] },
      hooks: { PreToolUse: [OLD_HOOK], PostToolUse: [{ hooks: [NEW_HOOK] }] },
    });
    expect(checkCopyReady({ mainDir: dir, copyDir: created.path }).ready).toBe(true);
  });

  it('нечитаемый файл копии дырой хуков не считается', async () => {
    const created = await addWorktree(dir, 'feature/broken-json');
    writeFileSync(join(created.path, SETTINGS), '{ не json');
    expect(checkCopyReady({ mainDir: dir, copyDir: created.path }).gaps).toEqual([]);
  });
});
