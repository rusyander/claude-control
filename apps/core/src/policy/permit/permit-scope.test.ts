import { describe, expect, it } from 'vitest';
import type { PermissionAsk } from '../../adapters/adapter.types.ts';
import { decidePermit } from './permit.ts';
import type { PermitContext } from './permit.types.ts';

/**
 * Границы сеанса от вызывающего (`task.created.session.scope`, этап 10 F6): правка вне масок
 * `scope.edit` и команды с префиксом из `scope.denyCommands` отказывает судья ядра — агент тестов
 * пишет только результаты, песочница/прогон не двигают историю git.
 */

const base: PermitContext = {
  copyRoot: process.cwd(),
  ownedPaths: [],
  deny: { paths: [], commands: [['git', 'push']], mcpTools: [], tools: [] },
  platformPaths: [],
  endpointSources: [],
  grantRequired: [],
  grants: [],
};
const scoped: PermitContext = {
  ...base,
  scope: {
    edit: ['.agent/tests', '.agent/tests/**', 'e2e/login.spec.ts'],
    denyCommands: [
      ['git', 'commit'],
      ['git', 'reset'],
    ],
  },
};

const edit = (target: string): PermissionAsk => ({
  action: 'edit',
  target,
  tool: 'Write',
  display: `edit ${target}`,
});
const exec = (line: string): PermissionAsk => ({
  action: 'exec',
  target: line,
  tool: 'Bash',
  display: line,
  argv: line.split(' '),
});

describe('session scope: edit', () => {
  it.each(['.agent/tests/gui.json', '.agent/tests/drafts/d.json', 'e2e/login.spec.ts'])(
    '%s inside the masks — allowed',
    (target) => {
      expect(decidePermit(edit(target), scoped)).toMatchObject({ allow: true });
    },
  );

  it.each(['src/app.ts', 'README.md', 'e2e/other.spec.ts', 'x/.agent/tests/a.json'])(
    '%s outside the masks — outside-scope',
    (target) => {
      expect(decidePermit(edit(target), scoped)).toMatchObject({
        allow: false,
        code: 'outside-scope',
      });
    },
  );

  it('no scope — the same edit is allowed (scope is opt-in per task)', () => {
    expect(decidePermit(edit('src/app.ts'), base)).toMatchObject({ allow: true });
  });
});

describe('session scope: commands', () => {
  it.each(['git commit -m x', 'git -C . commit -am y', 'git reset --hard'])(
    '%s — scope-command',
    (line) => {
      expect(decidePermit(exec(line), scoped)).toMatchObject({
        allow: false,
        code: 'scope-command',
      });
    },
  );

  it('git status and git diff stay allowed; git push stays a platform step', () => {
    expect(decidePermit(exec('git status'), scoped)).toMatchObject({ allow: true });
    expect(decidePermit(exec('git diff'), scoped)).toMatchObject({ allow: true });
    expect(decidePermit(exec('git push'), scoped)).toMatchObject({
      allow: false,
      code: 'platform-step',
    });
  });

  it('no scope — git commit is not refused by the session', () => {
    expect(decidePermit(exec('git commit -m x'), base)).toMatchObject({ allow: true });
  });
});
