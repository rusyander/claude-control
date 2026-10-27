import { homedir } from 'node:os';
import { join } from 'node:path';
import { GROUP_REQUEST_DEFAULTS } from '@agentdeck/contracts/split-groups';
import { describe, expect, it } from 'vitest';
import { groupDecision } from '../group-permissions.ts';

/**
 * Файл, который пишет сам git по ключу (D-9, 25.10). `git archive -o ../x.tar`,
 * `git diff --output=<дом>/x.patch`, `git format-patch -o ../p`, `git bundle create
 * ../x.bundle` судились чтением и шли сами — мимо суда путей, которым судится
 * `tar -x -C` вне копии. Вне копии и временного — человеку; в копии, во временном
 * и в поток (`-o -`) — как раньше.
 */
const slash = (path: string): string => path.replace(/\\/g, '/');
/** Копия не во временном: `..` от неё — чужое место, как у настоящей копии группы. */
const copy = slash(join(homedir(), '__agentdeck-test-no-such__', 'worktrees', 'fix-a'));
const home = slash(join(homedir(), 'git-output-x'));

const group = {
  rows: { ...GROUP_REQUEST_DEFAULTS },
  allowEdits: true,
  worktree: copy,
  base: 'main',
  ownBranch: 'fix/a',
  ignored: [],
  shellCwd: copy,
  parentChatId: 'p',
  groupIndex: 0,
  tree: { dirty: false as const },
};
const decide = (command: string): string =>
  groupDecision(group, { toolName: 'Bash', input: { command }, guardedPatterns: [] });

describe('git пишет файл по ключу — суд места записи (D-9)', () => {
  it.each([
    'git archive -o ../x.tar HEAD',
    'git archive -o../x.tar HEAD',
    `git archive --output=${home}.tar HEAD`,
    `git archive --output ${home}.tar HEAD`,
    `git archive --outp=${home}.tar HEAD`,
    'git diff --output=../x.patch',
    `git log -p --output=${home}.patch`,
    'git format-patch -o ../patches HEAD~1',
    'git format-patch --output-directory=../patches HEAD~1',
    'git bundle create ../x.bundle HEAD',
    'git -C .. archive -o x.tar HEAD',
    // От каталога `-C`, а не от оболочки: из подпапки `../../` — над копией.
    'git -C inst-docs-ui archive -o ../../x.tar HEAD',
    'git archive -o "$OUT" HEAD',
    'git archive -o',
  ])('вне копии и временного — человеку: %s', (command) => {
    expect(decide(command)).toBe('human');
  });

  it.each([
    'git archive -o .agent/tmp/x.tar HEAD',
    'git archive -o /tmp/x.tar HEAD',
    'git archive -o - HEAD',
    'git archive HEAD inst-docs-ui',
    'git diff --output=.agent/tmp/x.patch',
    'git -C inst-docs-ui diff --output=../.agent/tmp/x.patch',
    // `../x.tar` от `-C inst-docs-ui` — корень копии, не её родитель.
    'git -C inst-docs-ui archive -o ../x.tar HEAD',
    'git format-patch -o .agent/tmp/p HEAD~1',
    'git bundle create .agent/tmp/x.bundle HEAD',
    'git log --oneline -5',
  ])('в копии, во временном, в поток — само: %s', (command) => {
    expect(decide(command)).not.toBe('human');
  });
});
