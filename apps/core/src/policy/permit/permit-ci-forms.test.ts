import { describe, expect, it } from 'vitest';
import { mapClaudePermission } from '../../adapters/claude/permission.ts';
import { platformDenySet } from '../../adapters/deny-overlay.ts';
import { mapQwenPermission } from '../../adapters/qwen/permission.ts';
import { CI_READ_COMMANDS, PUBLISH_COMMANDS } from '../../lib/publish-commands.ts';
import { decidePermit } from './permit.ts';
import type { PermitContext } from './permit.types.ts';

/**
 * Чтение CI — дело ядра (ожидание CI задачи, R:S1-09): `gh run`, `gh pr checks`, `gh workflow
 * view|run`, `glab ci|pipeline|job` отказаны `platform-step` с причиной «CI читает ядро» в
 * каждой форме, которую оболочка исполнит как эту команду: `.exe`, путь к файлу, обёртка
 * `env`/`sudo`, PowerShell. Префиксы едут в ОДНОМ списке с публикацией — оверлей CLI видит те же.
 * Вход — настоящая дорога: сырой вызов инструмента через переходник → `decidePermit`.
 */

const ctx: PermitContext = {
  copyRoot: process.cwd(),
  ownedPaths: [],
  deny: platformDenySet({ coreHome: '/core-home-ci-test', tokenFiles: [] }),
  platformPaths: ['/core-home-ci-test'],
  endpointSources: [],
  grantRequired: [],
  grants: [],
};

const CI_REFUSED = {
  allow: false,
  code: 'platform-step',
  reason: 'CI state is read by the core (task ciWait)',
};

const bash = (command: string) =>
  decidePermit(mapClaudePermission({ tool: 'Bash', input: { command } }), ctx, 'work');
const pwsh = (command: string) =>
  decidePermit(mapClaudePermission({ tool: 'PowerShell', input: { command } }), ctx, 'work');
const qwen = (command: string) =>
  decidePermit(mapQwenPermission({ tool: 'run_shell_command', input: { command } }), ctx, 'work');

describe('CI reads are the core’s: every form refused with the CI reason', () => {
  it('the CI prefixes ride the one platform deny list (overlay unchanged in shape)', () => {
    expect(PUBLISH_COMMANDS).toEqual(expect.arrayContaining([...CI_READ_COMMANDS]));
    expect(ctx.deny.commands).toEqual(expect.arrayContaining(CI_READ_COMMANDS.map((p) => [...p])));
  });

  it.each([
    ['gh run', 'gh run watch 123'],
    ['gh run list', 'gh run list --limit 1'],
    ['gh pr checks', 'gh pr checks 7 --watch'],
    ['gh workflow view', 'gh workflow view ci.yml'],
    ['gh workflow run', 'gh workflow run ci.yml'],
    ['glab ci', 'glab ci status'],
    ['glab pipeline', 'glab pipeline list'],
    ['glab job', 'glab job view 9'],
    ['.exe', 'gh.exe run watch 1'],
    ['path-qualified', '/usr/local/bin/glab ci view'],
    ['windows path .exe', '"C:\\Program Files\\GitHub CLI\\gh.exe" pr checks 7'],
    ['env-wrapped', 'env GH_TOKEN=x gh run list'],
    ['sudo-wrapped', 'sudo -u ci glab pipeline status'],
    ['global flag before verb', 'gh -R o/r run list'],
    ['chained after a harmless command', 'cd src && glab job trace 4'],
  ])('bash %s: %s', (_form, command) => {
    expect(bash(command)).toMatchObject(CI_REFUSED);
    expect(qwen(command)).toMatchObject(CI_REFUSED);
  });

  it.each([
    ['PowerShell bare', 'gh run watch 1'],
    ['PowerShell call operator', "& 'C:\\Tools\\glab.exe' ci status"],
    ['PowerShell .exe', 'glab.exe pipeline list'],
  ])('%s: %s', (_form, command) => {
    expect(pwsh(command)).toMatchObject(CI_REFUSED);
  });

  it('publishing beside a CI read is named publishing; forge reads outside CI stay allowed', () => {
    expect(bash('gh run list && git push')).toMatchObject({
      allow: false,
      code: 'platform-step',
      reason: 'publishing is a platform step',
    });
    expect(bash('gh pr view 7')).toMatchObject({ allow: true });
    expect(bash('glab mr view 3')).toMatchObject({ allow: true });
    expect(bash('gh -R o/r pr view 7')).toMatchObject({ allow: true });
  });

  it('forge flags before the verb (cobra takes them anywhere) no longer slip past publishing', () => {
    for (const command of [
      'gh -R o/r pr create --fill',
      'gh --repo=o/r pr merge 7',
      'glab -R g/p mr create',
      'gh --hostname h -R o/r pr comment 1 -b x',
    ])
      expect(bash(command)).toMatchObject({
        allow: false,
        code: 'platform-step',
        reason: 'publishing is a platform step',
      });
  });
});
