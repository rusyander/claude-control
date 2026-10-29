import { describe, expect, it } from 'vitest';
import { mapClaudePermission } from '../adapters/claude/permission.ts';
import { PUBLISH_COMMANDS } from '../adapters/deny-overlay.ts';
import { decidePermit } from '../policy/permit/permit.ts';
import type { PermitContext } from '../policy/permit/permit.types.ts';

/**
 * core-s2 F-04: оверлей CLI и судья знают ОДНИ дороги публикации. Сверка — по поведению обоих
 * замков, а не по импорту: оверлей — его список префиксов, судья — его решение над командой, когда
 * в запретах сеанса только `git push` (так видно, что судья сам считает равным push). Подкоманда,
 * которую один замок считает публикацией, а другой — нет, краснит тест.
 */

const ctx = (commands: string[][]): PermitContext => ({
  copyRoot: '/work/copy',
  ownedPaths: [],
  deny: { paths: [], commands, mcpTools: [], tools: [] },
  platformPaths: [],
  endpointSources: [],
  grantRequired: [],
  grants: [],
});

const judgedPublish = (command: string, commands: string[][]): boolean => {
  const verdict = decidePermit(
    mapClaudePermission({ tool: 'Bash', input: { command } }),
    ctx(commands),
  );
  return !verdict.allow && verdict.code === 'platform-step';
};

const overlayHas = (argv: readonly string[]): boolean =>
  PUBLISH_COMMANDS.some(
    (prefix) => prefix.length === argv.length && prefix.every((w, i) => w === argv[i]),
  );

/** Подкоманды git: публикующие и соседние, которые публикацией не являются. */
const GIT_VOCABULARY: readonly (readonly string[])[] = [
  ['push'],
  ['http-push'],
  ['send-pack'],
  ['receive-pack'],
  ['send-email'],
  ['cvsexportcommit'],
  ['subtree', 'push'],
  ['lfs', 'push'],
  ['svn', 'dcommit'],
  ['p4', 'submit'],
  ['fetch'],
  ['pull'],
  ['status'],
  ['subtree', 'pull'],
  ['lfs', 'pull'],
  ['svn', 'fetch'],
  ['p4', 'sync'],
  ['request-pull'],
  ['format-patch'],
  ['bundle', 'create'],
];

describe('F-04: the CLI overlay and the judge read one publish list', () => {
  it.each(GIT_VOCABULARY.map((form) => [form.join(' '), form] as const))(
    'git %s: the overlay denies it exactly when the judge treats it as push',
    (_name, form) => {
      const judge = judgedPublish(`git ${form.join(' ')} origin main`, [['git', 'push']]);
      expect({ form, overlay: overlayHas(['git', ...form]) }).toEqual({ form, overlay: judge });
    },
  );

  it('every git publish road of the overlay is push for the judge (set-url aside: a config write)', () => {
    const missed = PUBLISH_COMMANDS.filter((argv) => argv[0] === 'git' && argv[1] !== 'remote')
      .filter((argv) => !judgedPublish(`${argv.join(' ')} origin`, [['git', 'push']]))
      .map((argv) => argv.join(' '));
    expect(missed).toEqual([]);
  });

  it('with the session deny set, the judge refuses every overlay prefix', () => {
    const all = PUBLISH_COMMANDS.map((argv) => [...argv]);
    const allowed = PUBLISH_COMMANDS.filter(
      (argv) => !judgedPublish(`${argv.join(' ')} x`, all),
    ).map((argv) => argv.join(' '));
    expect(allowed).toEqual([]);
  });
});
