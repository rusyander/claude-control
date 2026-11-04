import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionLayerCarry, SessionSpec } from '../adapter.types.ts';
import { trustedLayer } from '../sdk-stream/layer-run.ts';
import { planClaude } from './claude.ts';
import { dropsUserKeepsProject, personalMemoryExcludes } from './personal-memory.ts';

/**
 * Исключение личного `CLAUDE.md` при снятом источнике `user` (s10 p9, перенос `userMemoryExcludes`
 * панели). Что исключение срабатывает в настоящем CLI, доказывает живой случай «under the home» в
 * `claude.carry.live.integration.test.ts`; здесь — ровно нужные файлы и условие, при котором они
 * едут в `--settings` ядра.
 */

describe('personal memory excludes — the files', () => {
  it('linux: home and config dir, all three instruction names; the monorepo CLAUDE.md untouched', () => {
    const list = personalMemoryExcludes({ HOME: '/home/u' }, '/home/u/mono/app', 'linux');
    expect(list).toEqual([
      '/home/u/.claude/CLAUDE.md',
      '/home/u/.claude/CLAUDE.local.md',
      '/home/u/.claude/AGENTS.md',
    ]);
    expect(list.some((file) => file.startsWith('/home/u/mono'))).toBe(false);
  });

  it('own CLAUDE_CONFIG_DIR, and an ancestor that IS that dir', () => {
    expect(
      personalMemoryExcludes(
        { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/cfg' },
        '/cfg/sandbox/app',
        'linux',
      ),
    ).toEqual([
      '/cfg/CLAUDE.md',
      '/cfg/CLAUDE.local.md',
      '/cfg/AGENTS.md',
      '/home/u/.claude/CLAUDE.md',
      '/home/u/.claude/CLAUDE.local.md',
      '/home/u/.claude/AGENTS.md',
    ]);
  });

  it('windows: the cwd spelling, forward slashes and the caseless pattern', () => {
    const list = personalMemoryExcludes(
      { USERPROFILE: 'C:\\Users\\Ivan (Work)', HOME: '/ignored' },
      'c:\\users\\ivan (work)\\mono\\app',
      'win32',
    );
    expect(list).toEqual([
      'C:/Users/Ivan (Work)/.claude/CLAUDE.md',
      'C:/Users/Ivan (Work)/.claude/CLAUDE.local.md',
      'C:/Users/Ivan (Work)/.claude/AGENTS.md',
      'c:/users/ivan (work)/.claude/CLAUDE.md',
      'c:/users/ivan (work)/.claude/CLAUDE.local.md',
      'c:/users/ivan (work)/.claude/AGENTS.md',
      '[cC]:/[uU][sS][eE][rR][sS]/[iI][vV][aA][nN] [(][wW][oO][rR][kK][)]/.[cC][lL][aA][uU][dD][eE]/[cC][lL][aA][uU][dD][eE].[mM][dD]',
      '[cC]:/[uU][sS][eE][rR][sS]/[iI][vV][aA][nN] [(][wW][oO][rR][kK][)]/.[cC][lL][aA][uU][dD][eE]/[cC][lL][aA][uU][dD][eE].[lL][oO][cC][aA][lL].[mM][dD]',
      '[cC]:/[uU][sS][eE][rR][sS]/[iI][vV][aA][nN] [(][wW][oO][rR][kK][)]/.[cC][lL][aA][uU][dD][eE]/[aA][gG][eE][nN][tT][sS].[mM][dD]',
    ]);
  });

  it('windows: the config dir met on the way up is excluded in the cwd spelling too', () => {
    const list = personalMemoryExcludes(
      { USERPROFILE: 'C:\\Users\\u', CLAUDE_CONFIG_DIR: 'C:\\Cfg' },
      'c:\\cfg\\sandbox\\app',
      'win32',
    );
    expect(list).toEqual(
      expect.arrayContaining(['C:/Cfg/CLAUDE.md', 'c:/cfg/CLAUDE.md', 'c:/cfg/AGENTS.md']),
    );
  });

  it('windows: a path with `[` stays literal only — a class would break the pattern', () => {
    expect(personalMemoryExcludes({ USERPROFILE: 'D:\\p[1]' }, 'D:\\p[1]\\app', 'win32')).toEqual([
      'D:/p[1]/.claude/CLAUDE.md',
      'D:/p[1]/.claude/CLAUDE.local.md',
      'D:/p[1]/.claude/AGENTS.md',
    ]);
  });

  it('the condition: project kept, user dropped — and nothing else', () => {
    expect(dropsUserKeepsProject(['project', 'local'])).toBe(true);
    expect(dropsUserKeepsProject(['project'])).toBe(true);
    expect(dropsUserKeepsProject(['user', 'project', 'local'])).toBe(false);
    expect(dropsUserKeepsProject(['local'])).toBe(false);
    expect(dropsUserKeepsProject([])).toBe(false);
    expect(dropsUserKeepsProject(undefined)).toBe(false);
  });
});

const base = mkdtempSync(join(tmpdir(), 'personal-memory-'));
const HOME = join(base, 'home');
const CWD = join(HOME, 'proj');

function spec(carry?: SessionLayerCarry, over: Partial<SessionSpec['layer']> = {}): SessionSpec {
  return {
    sessionId: '44444444-4444-4444-8444-444444444444',
    dir: join(base, 'session'),
    cwd: CWD,
    brief: 'BRIEF',
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    platform: { coreHome: join(base, 'core'), tokenFiles: [] },
    tools: 'all',
    mcpServers: {},
    layer: { hooks: 'on', skills: 'on', ...(carry ? { carry } : {}), ...over },
    env: { pin: { HOME, USERPROFILE: HOME } },
    coreHook: 'node core.mjs',
    core: {
      taskId: 't',
      stepId: 's',
      stepKind: 'implement',
      coreUrl: 'http://127.0.0.1:1',
      sessionToken: 'tok',
    },
  };
}

const excludesOf = (s: SessionSpec): string[] | undefined =>
  (
    JSON.parse(planClaude(s, null, trustedLayer(s)).files['claude/settings.json'] as string) as {
      claudeMdExcludes?: string[];
    }
  ).claudeMdExcludes;

describe('planClaude — the personal excludes ride --settings exactly when user is dropped', () => {
  const personal = join(HOME, '.claude', 'CLAUDE.md').replaceAll('\\', '/');

  it('layer on + settingSources project,local: the personal CLAUDE.md is excluded', () => {
    const s = spec({ settingSources: ['project', 'local'] });
    expect(excludesOf(s)).toEqual(expect.arrayContaining([personal]));
    // Проектный `CLAUDE.md` в cwd остаётся правилами задачи.
    expect(excludesOf(s)?.some((e) => e.startsWith(CWD.replaceAll('\\', '/')))).toBe(false);
  });

  it('user kept, no carry, project dropped, sources user, layer observe: nothing excluded', () => {
    expect(excludesOf(spec({ settingSources: ['user', 'project', 'local'] }))).toBeUndefined();
    expect(excludesOf(spec())).toBeUndefined();
    expect(excludesOf(spec({ settingSources: ['local'] }))).toBeUndefined();
    expect(
      excludesOf(spec({ settingSources: ['project', 'local'] }, { sources: 'user' })),
    ).toBeUndefined();
    expect(
      excludesOf(spec({ settingSources: ['project', 'local'] }, { hooks: 'observe' })),
    ).toBeUndefined();
  });
});
