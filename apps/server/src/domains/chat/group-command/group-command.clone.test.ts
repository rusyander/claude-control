import { describe, expect, it } from 'vitest';
import { GROUP_REQUEST_DEFAULTS } from '@agentdeck/contracts/split-groups';
import { groupDecision, type GroupAutoApprove } from '../group-permissions.ts';
import { groupCommandVerdict, type GroupCommandScope } from './group-command.ts';

/**
 * Свежий клон — пробный репозиторий только дальше по той же цепочке `&&`
 * (решение 23.10, корпус R: `git clone --shared . "$S"` в своей рабочей папке
 * и `git checkout -b` в нём шли человеку). После `;`, `||`, трубы, `!` или в
 * другой подоболочке клон мог не выйти, и `cd` с `git checkout` попали бы в
 * прежний каталог.
 */
const COPY = 'C:/work/shop-worktrees/fix-PROJ-77-clone';
const PAD = 'C:/Users/me/AppData/Local/Temp/claude/proj/session-a/scratchpad';
const SCOPE: GroupCommandScope = {
  worktree: COPY,
  branch: 'fix-PROJ-77/clone',
  ignored: [],
  cwd: COPY,
  scratchpad: PAD,
};
const GROUP: GroupAutoApprove = {
  rows: { ...GROUP_REQUEST_DEFAULTS },
  allowEdits: true,
  worktree: COPY,
  ignored: [],
  ownBranch: 'fix-PROJ-77/clone',
  shellCwd: COPY,
  scratchpad: PAD,
  tree: { dirty: false },
  parentChatId: 'p',
  groupIndex: 0,
};
const kind = (command: string): string => groupCommandVerdict(command, SCOPE).kind;
const decide = (command: string): string =>
  groupDecision(GROUP, { toolName: 'Bash', input: { command }, guardedPatterns: [] });
const S = `S="${PAD}/rv1785"; `;

describe('свежий клон по цепочке `&&` — пробный репозиторий', () => {
  it.each([
    `${S}git clone -q --shared --no-checkout . "$S" && cd "$S" && git checkout -q -b review-x 604a298f`,
    `${S}git clone -q --shared . "$S" && cd "$S" && git config core.protectNTFS false && git log --oneline -2`,
    `${S}git clone --depth 1 . "$S" && git -C "$S" commit --allow-empty -m probe`,
    `git clone -q . /tmp/probe-x && cd /tmp/probe-x && git reset --hard HEAD~1`,
  ])('само: %s', (command) => {
    expect(kind(command)).not.toBe('danger');
    expect(decide(command)).toBe('auto');
  });

  it.each([
    // Разрыв цепочки: клон мог не выйти.
    `${S}git clone -q --shared . "$S"; cd "$S" && git checkout -q -b review-x`,
    `${S}git clone -q --shared . "$S" 2>&1 | tail -2; cd "$S" && git checkout -q -b review-x`,
    `${S}git clone -q --shared . "$S" | tail -2 && cd "$S" && git checkout -q -b review-x`,
    `${S}git clone -q --shared . "$S" || true && cd "$S" && git checkout -q -b review-x`,
    `${S}! git clone -q --shared . "$S" && cd "$S" && git checkout -q -b review-x`,
    `${S}git clone -q --shared . "$S" && cd "$S"; git checkout -q -b review-x`,
    `${S}(git clone -q --shared . "$S") && cd "$S" && git checkout -q -b review-x`,
    // Цепочка цела, но из пробного наружу: пуш в источник, каталог вне временного.
    `${S}git clone -q . "$S" && cd "$S" && git push origin HEAD:main`,
    'git clone -q . /c/work/other-x && cd /c/work/other-x && git checkout -q -b y',
    // Каталог git не там, где клон, или ключ не узнан.
    `${S}git clone --separate-git-dir=/c/work/shop/.git2 . "$S" && cd "$S" && git reset --hard`,
    `${S}git clone --sep=/c/work/shop/.git2 . "$S" && cd "$S" && git reset --hard`,
  ])('человеку: %s', (command) => {
    expect(kind(command)).toBe('danger');
    expect(decide(command)).toBe('human');
  });
});
