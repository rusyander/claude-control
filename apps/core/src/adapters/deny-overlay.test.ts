import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cliProjectDirs,
  copyGitDirs,
  platformDenySet,
  PUBLISH_COMMANDS,
  sessionPermitDeny,
  withPlatformDeny,
} from './deny-overlay.ts';

/** Запреты платформы: что несёт каждый сеанс и что шаг снять не может (06, 05 §Push closure). */

const FACTS = {
  coreHome: '/core-home',
  tokenFiles: ['/core-home/api-token', '/t/forge-token', '/core-home'],
  forgeMcpTools: ['mcp__forge__create_mr', 'mcp__forge__create_mr'],
};

describe('platform deny set', () => {
  it('denies the core home, token files and forge write tools once each, and every publish road', () => {
    expect(platformDenySet(FACTS)).toEqual({
      paths: ['/core-home', '/core-home/api-token', '/t/forge-token'],
      commands: PUBLISH_COMMANDS.map((argv) => [...argv]),
      mcpTools: ['mcp__forge__create_mr'],
      tools: [],
    });
    expect(PUBLISH_COMMANDS).toEqual(
      expect.arrayContaining([
        ['git', 'push'],
        ['gh', 'pr', 'create'],
        ['gh', 'api'],
        ['glab', 'mr', 'create'],
        ['glab', 'api'],
      ]),
    );
    expect(platformDenySet({ coreHome: '/h', tokenFiles: [] }).mcpTools).toEqual([]);
  });

  it('hands out copies: changing a returned set leaves the next session intact', () => {
    const first = platformDenySet(FACTS);
    (first.commands[0] as string[]).push('--force');
    first.commands.length = 0;
    expect(platformDenySet(FACTS).commands[0]).toEqual(['git', 'push']);
    expect(platformDenySet(FACTS).commands).toHaveLength(PUBLISH_COMMANDS.length);
  });

  it('a step adds to the platform denials and cannot drop one; duplicates merge by argv', () => {
    const merged = withPlatformDeny(FACTS, {
      paths: ['/core-home', '/w/secret'],
      commands: [
        ['git', 'push'],
        ['npm', 'publish'],
      ],
      mcpTools: ['mcp__x__y', 'mcp__forge__create_mr'],
      tools: ['web', 'web'],
    });
    expect(merged.paths).toEqual([
      '/core-home',
      '/core-home/api-token',
      '/t/forge-token',
      '/w/secret',
    ]);
    expect(merged.commands.filter((c) => c.join(' ') === 'git push')).toHaveLength(1);
    expect(merged.commands.at(-1)).toEqual(['npm', 'publish']);
    expect(merged.commands).toHaveLength(PUBLISH_COMMANDS.length + 1);
    expect(merged.mcpTools).toEqual(['mcp__forge__create_mr', 'mcp__x__y']);
    expect(merged.tools).toEqual(['web']);
    expect(withPlatformDeny(FACTS, { paths: [], commands: [], mcpTools: [], tools: [] })).toEqual(
      platformDenySet(FACTS),
    );
  });
});

describe("the copy's git dir is edit-denied in every launch", () => {
  const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'deny-git-')));
  const NONE = { paths: [], commands: [], mcpTools: [], tools: [] };

  it('a plain repo: its .git, found from any directory below the copy root', () => {
    const copy = tmp();
    mkdirSync(join(copy, '.git'));
    mkdirSync(join(copy, 'src', 'deep'), { recursive: true });
    expect(copyGitDirs(copy)).toEqual([join(copy, '.git')]);
    expect(copyGitDirs(join(copy, 'src', 'deep'))).toEqual([join(copy, '.git')]);
  });

  it('a worktree: the .git file, its gitdir and the common dir where config and hooks live', () => {
    const root = tmp();
    const main = join(root, 'main', '.git');
    const gitdir = join(main, 'worktrees', 'wt');
    const copy = join(root, 'wt');
    mkdirSync(gitdir, { recursive: true });
    mkdirSync(copy);
    writeFileSync(join(copy, '.git'), `gitdir: ${gitdir}\n`);
    writeFileSync(join(gitdir, 'commondir'), '../..\n');
    expect(copyGitDirs(copy)).toEqual([join(copy, '.git'), gitdir, main]);
    // Относительный gitdir — от каталога файла `.git`; без commondir — только два.
    const rel = join(root, 'rel');
    mkdirSync(rel);
    writeFileSync(join(rel, '.git'), 'gitdir: ../main/.git\n');
    expect(copyGitDirs(rel)).toEqual([join(rel, '.git'), main]);
  });

  it('a .git file that names no gitdir is still denied itself', () => {
    const copy = tmp();
    writeFileSync(join(copy, '.git'), 'garbage');
    expect(copyGitDirs(copy)).toEqual([join(copy, '.git')]);
  });

  it('the git dirs join as edit-only paths; read stays allowed, a path denied whole is not repeated', () => {
    const copy = tmp();
    mkdirSync(join(copy, '.git'));
    const merged = withPlatformDeny(FACTS, NONE, copy);
    const settings = [join(copy, '.claude'), join(copy, '.qwen')];
    expect(merged.editPaths).toEqual([join(copy, '.git'), ...settings]);
    expect(merged.paths).toEqual(platformDenySet(FACTS).paths);
    const whole = withPlatformDeny(FACTS, { ...NONE, paths: [join(copy, '.git')] }, copy);
    expect(whole.editPaths).toEqual(settings);
    expect(withPlatformDeny(FACTS, { ...NONE, editPaths: ['/x'] }).editPaths).toEqual(['/x']);
  });
});

describe('review core-s2: the copy is closed up to its outermost repo', () => {
  const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'deny-outer-')));
  const NONE = { paths: [], commands: [], mcpTools: [], tools: [] };

  it('F-37: cwd in a nested repo still denies the outer copy .git', () => {
    const copy = tmp();
    mkdirSync(join(copy, '.git'));
    const vendored = join(copy, 'vendor', 'lib');
    mkdirSync(join(vendored, '.git'), { recursive: true });
    expect(copyGitDirs(vendored)).toEqual([join(vendored, '.git'), join(copy, '.git')]);
  });

  it('F-12: CLI settings dirs are edit-denied on every level up to the outermost repo root', () => {
    const copy = tmp();
    mkdirSync(join(copy, '.git'));
    const sub = join(copy, 'pkg', 'app');
    mkdirSync(sub, { recursive: true });
    const levels = [sub, join(copy, 'pkg'), copy];
    expect(cliProjectDirs(sub)).toEqual(
      levels.flatMap((level) => [join(level, '.claude'), join(level, '.qwen')]),
    );
    // Репозитория нет — только у cwd.
    const bare = tmp();
    expect(cliProjectDirs(bare)).toEqual([join(bare, '.claude'), join(bare, '.qwen')]);
  });

  it('F-11: the judge gets the deny set the CLI overlay gets, plus the platform paths', () => {
    const copy = tmp();
    mkdirSync(join(copy, '.git'));
    const step = { ...NONE, commands: [['npm', 'publish']] };
    const permit = sessionPermitDeny(FACTS, step, copy);
    expect(permit.deny).toEqual(withPlatformDeny(FACTS, step, copy));
    expect(permit.deny.commands).toEqual(
      expect.arrayContaining([
        ['gh', 'api'],
        ['npm', 'publish'],
      ]),
    );
    expect(permit.deny.editPaths).toEqual(
      expect.arrayContaining([join(copy, '.git'), join(copy, '.claude')]),
    );
    expect(permit.platformPaths).toEqual(['/core-home', '/core-home/api-token', '/t/forge-token']);
  });

  it('publish roads beyond push: other transports, push url rewrite, forge write verbs', () => {
    expect(PUBLISH_COMMANDS).toEqual(
      expect.arrayContaining([
        ['git', 'send-pack'],
        ['git', 'http-push'],
        ['git', 'receive-pack'],
        ['git', 'subtree', 'push'],
        ['git', 'remote', 'set-url', '--push'],
        ['gh', 'pr', 'merge'],
        ['glab', 'mr', 'merge'],
      ]),
    );
  });
});
