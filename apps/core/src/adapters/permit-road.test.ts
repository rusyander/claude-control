import { describe, expect, it } from 'vitest';

import { decidePermit } from '../policy/permit/permit.ts';
import type { PermitContext } from '../policy/permit/permit.types.ts';
import { mapClaudePermission } from './claude/permission.ts';
import { platformDenySet } from './deny-overlay.ts';
import { mapQwenPermission } from './qwen/permission.ts';

/**
 * Дорога права целиком: сырой вызов оболочки CLI → вопрос переходника → судья прав. Типизированный
 * argv несёт только первую команду строки, поэтому вся строка идёт судье в `display` (P28) — без
 * неё `git status && git push` прошёл бы как `git status` (замечание W2-B 28.10).
 */
const ctx: PermitContext = {
  copyRoot: '/work/copy',
  ownedPaths: [],
  deny: platformDenySet({ coreHome: '/core-home', tokenFiles: [] }),
  platformPaths: ['/core-home'],
  endpointSources: [],
  grantRequired: [],
  grants: [],
};

const ADAPTERS = [
  ['claude', (command: string) => mapClaudePermission({ tool: 'Bash', input: { command } })],
  [
    'qwen',
    (command: string) => mapQwenPermission({ tool: 'run_shell_command', input: { command } }),
  ],
] as const;

describe.each(ADAPTERS)('permit road through the %s adapter', (_id, ask) => {
  it.each([
    'git status && git push origin HEAD',
    'git status; git push',
    'git status || git push origin main',
    'git log -1 | xargs git push',
    'echo "$(git push origin HEAD)"',
  ])('a push hidden after the first command is refused: %s', (command) => {
    const mapped = ask(command);
    expect(mapped.argv?.[1]).not.toBe('push');
    expect(decidePermit(mapped, ctx)).toMatchObject({ allow: false, code: 'platform-step' });
  });

  it('a chain without a publish is not refused for publishing', () => {
    expect(decidePermit(ask('git status && git log -1'), ctx)).not.toMatchObject({
      code: 'platform-step',
    });
  });
});
