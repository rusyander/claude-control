import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionSpec } from '../adapter.types.ts';
import { trustedLayer } from '../sdk-stream/layer-run.ts';
import { planClaude } from './claude.ts';
import { caselessGlob, copyParity, sourceTails } from './copy-parity.ts';

/**
 * Паритет копии (E1, перенос `copy-parity` панели): исключения инструкций источника
 * (`claudeMdExcludes`) переписаны на корень копии и едут в `--settings` ядра; не копия — пусто;
 * нечитаемый файл настроек назван в `layerDetail`, сессия идёт.
 */

const slash = (p: string): string => p.replaceAll('\\', '/');
const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
};

/** Источник — настоящий репозиторий, копия — его рабочее дерево в `<проект>-worktrees/`. */
function fixture(userExcludes: (source: string) => string[]) {
  const root = mkdtempSync(join(tmpdir(), 'parity-'));
  const source = join(root, 'proj');
  const copy = join(root, 'proj-worktrees', 'task-1');
  const config = join(root, 'cfg');
  mkdirSync(join(source, '.claude', 'rules'), { recursive: true });
  mkdirSync(config, { recursive: true });
  writeFileSync(join(source, 'CLAUDE.md'), '# team rules\n');
  writeFileSync(join(source, '.claude', 'rules', 'big.md'), 'rule\n');
  git(source, 'init', '-q', '-b', 'main');
  git(source, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  git(source, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  git(source, 'worktree', 'add', '-q', copy);
  writeFileSync(
    join(config, 'settings.json'),
    JSON.stringify({ claudeMdExcludes: userExcludes(source) }),
  );
  return { root, source, copy, config };
}

function spec(cwd: string, config: string, sourceRepo: string): SessionSpec {
  return {
    sessionId: '33333333-3333-4333-8333-333333333333',
    dir: join(cwd, '..', 'session'),
    cwd,
    brief: 'BRIEF',
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    platform: { coreHome: join(cwd, '..', 'core'), tokenFiles: [] },
    tools: 'all',
    mcpServers: {},
    layer: { hooks: 'on', skills: 'on' },
    env: { pin: { CLAUDE_CONFIG_DIR: config } },
    coreHook: 'node core.mjs',
    recorder: { command: 'node rec.mjs', log: join(cwd, '..', 'rec.jsonl') },
    core: {
      taskId: 't',
      stepId: 's',
      stepKind: 'implement',
      coreUrl: 'http://127.0.0.1:1',
      sessionToken: 'tok',
    },
    trust: { sourceRepo, panelMark: true },
  };
}

const settingsOf = (plan: ReturnType<typeof planClaude>) =>
  JSON.parse(plan.files['claude/settings.json'] as string) as { claudeMdExcludes?: string[] };

describe('claude copy parity (E1)', () => {
  it('integration: source excludes (floating + absolute) are rewritten onto the git worktree and ride --settings', () => {
    const f = fixture((source) => [
      '**/proj/CLAUDE.md',
      `${slash(source)}/.claude/rules/**`,
      '**/node_modules/**',
    ]);
    const s = spec(f.copy, f.config, f.source);
    const plan = planClaude(s, null, trustedLayer(s));
    const copy = slash(f.copy);
    const want = [`${copy}/CLAUDE.md`, `${copy}/.claude/rules/**`];
    const caseless = process.platform === 'win32' || process.platform === 'darwin';
    const excludes = settingsOf(plan).claudeMdExcludes ?? [];
    for (const w of want) expect(excludes).toContain(w);
    if (caseless) expect(excludes).toContain(`${caselessGlob(copy)}/CLAUDE.md`);
    // Не привязанный к источнику шаблон копию узнаёт сам — не переписывается и не дублируется.
    expect(excludes.some((e) => e.includes('node_modules'))).toBe(false);
    expect(plan.layerDetail).toBe(
      `copy parity: ${excludes.length} claudeMdExcludes rewritten to the copy`,
    );
  });

  it('the source itself (cwd = sourceRepo) and layer observe/off get nothing', () => {
    const f = fixture(() => ['**/proj/CLAUDE.md']);
    const same = spec(f.source, f.config, f.source);
    expect(settingsOf(planClaude(same, null, trustedLayer(same))).claudeMdExcludes).toBeUndefined();
    const observe = {
      ...spec(f.copy, f.config, f.source),
      layer: { hooks: 'observe' as const, skills: 'on' as const },
    };
    expect(
      settingsOf(planClaude(observe, null, trustedLayer(observe))).claudeMdExcludes,
    ).toBeUndefined();
    const noTrust = { ...spec(f.copy, f.config, f.source), trust: undefined };
    expect(
      settingsOf(planClaude(noTrust, null, trustedLayer(noTrust))).claudeMdExcludes,
    ).toBeUndefined();
  });

  it('project and local settings of the copy count too; a broken settings file is named, not fatal', () => {
    const f = fixture(() => []);
    mkdirSync(join(f.copy, '.claude'), { recursive: true });
    writeFileSync(
      join(f.copy, '.claude', 'settings.json'),
      JSON.stringify({ claudeMdExcludes: ['**/proj/docs/**'] }),
    );
    writeFileSync(join(f.copy, '.claude', 'settings.local.json'), '{broken');
    const got = copyParity({
      sourceRepo: f.source,
      cwd: f.copy,
      pin: { CLAUDE_CONFIG_DIR: f.config },
    });
    expect(got.excludes).toContain(`${slash(f.copy)}/docs/**`);
    expect(got.detail).toMatch(
      /copy parity: settings unread, not rewritten \(.*settings\.local\.json: not JSON: .* → run\)/,
    );
  });

  it('an unreadable settings file (reader error) is unknown → run without it, named', () => {
    const got = copyParity({
      sourceRepo: '/src/proj',
      cwd: '/w/proj-worktrees/t',
      pin: { CLAUDE_CONFIG_DIR: '/cfg' },
      os: 'linux',
      read: (p) =>
        p.endsWith(join('cfg', 'settings.json'))
          ? { unknown: 'EACCES' }
          : { value: Buffer.from(JSON.stringify({ claudeMdExcludes: ['/src/proj/A.md'] })) },
    });
    expect(got.excludes).toEqual(['/w/proj-worktrees/t/A.md']);
    expect(got.detail).toContain('settings unread, not rewritten');
    expect(got.detail).toContain('EACCES → run');
  });

  it('sourceTails: absolute prefix, every floating anchor length, unanchored patterns give nothing', () => {
    expect(sourceTails('/work/proj/a/**', '/work/proj', false)).toEqual(['a/**']);
    expect(sourceTails('**/work/proj/CLAUDE.md', '/work/proj', false)).toEqual(['CLAUDE.md']);
    expect(sourceTails('**/proj/**/CLAUDE.md', '/work/proj', false)).toEqual(['**/CLAUDE.md']);
    expect(sourceTails('**/PROJ/x', 'C:/work/proj', true)).toEqual(['x']);
    expect(sourceTails('**/PROJ/x', '/work/proj', false)).toEqual([]);
    expect(sourceTails('**/CLAUDE.md', '/work/proj', false)).toEqual([]);
    expect(sourceTails('/other/a', '/work/proj', false)).toEqual([]);
  });
});
