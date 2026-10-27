import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GROUP_REQUEST_DEFAULTS } from '@agentdeck/contracts/split-groups';
import { groupDecision, type GroupAutoApprove } from '../group-permissions.ts';
import { groupCommandVerdict, type GroupCommandScope } from './group-command.ts';

/**
 * Клон, который сделал `review-plan.mjs plan` (метка `.git/review-plan-scratch.json`), —
 * пробный каталог рецензента: удаление и запись в нём — уборка, git там — пробный
 * репозиторий (D-5 26.10: `rm` пробного файла в клоне ушёл человеку). Каталог без метки
 * во временном, битая метка, метка в копии, основной копии, их предке, дома, путь по
 * ссылке из клона наружу — как раньше. Фикстуры настоящие: суд читает метку с диска.
 */
const T = mkdtempSync(join(tmpdir(), 'gc-review-scratch-'));
afterAll(() => rmSync(T, { recursive: true, force: true }));
const fwd = (p: string): string => p.split('\\').join('/');
const MAIN = join(T, 'main');
const COPY = join(T, 'copy');
const CLONE = join(T, 'claude-review', 'review-docs-x', 'clone');
const SUB = join(CLONE, 'inst-docs-ui');
const UNMARKED = join(T, 'claude-review', 'review-other', 'clone');
const BAD = join(T, 'bad', 'clone');
const BARE = join(T, 'claude-review', 'review-bare', 'clone');
const SELF = join(T, 'self', 'clone');
const HEADLESS = join(T, 'claude-review', 'review-headless', 'clone');
const LISTED = join(T, 'claude-review', 'review-listed', 'clone');
const HOME = join(T, 'home');
const DEPS = join(T, 'real-deps');
const mark = (dir: string, body: string): void => {
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'abc123\n');
  writeFileSync(join(dir, '.git', 'review-plan-scratch.json'), body);
};
mkdirSync(join(MAIN, '.git', 'worktrees', 'copy'), { recursive: true });
mkdirSync(join(MAIN, 'src'), { recursive: true });
mkdirSync(COPY, { recursive: true });
writeFileSync(join(COPY, '.git'), `gitdir: ${fwd(MAIN)}/.git/worktrees/copy\n`);
mkdirSync(join(SUB, 'scripts'), { recursive: true });
mkdirSync(DEPS, { recursive: true });
symlinkSync(DEPS, join(SUB, 'node_modules'), 'junction');
mark(
  CLONE,
  JSON.stringify({ source: COPY, head: 'abc123', links: [join(SUB, 'node_modules')], deps: 'x' }),
);
mkdirSync(join(UNMARKED, '.git'), { recursive: true });
writeFileSync(join(UNMARKED, '.git', 'HEAD'), 'abc123\n');
mark(BARE, JSON.stringify({ source: COPY, head: 'abc123', links: [] }));
mark(BAD, '{"source": ');
mark(SELF, JSON.stringify({ source: SELF, head: 'abc123' }));
mark(HEADLESS, JSON.stringify({ source: COPY, links: [] }));
// Названная планом ссылка — уже обычный каталог; ссылка `ext` наружу плану не названа.
mkdirSync(join(LISTED, 'deps', 'pkg'), { recursive: true });
symlinkSync(DEPS, join(LISTED, 'ext'), 'junction');
mark(LISTED, JSON.stringify({ source: COPY, head: 'abc123', links: [join(LISTED, 'deps')] }));

const SCOPE: GroupCommandScope = {
  worktree: COPY,
  branch: 'fix-PROJ-77/review',
  ignored: [],
  cwd: COPY,
};
const GROUP: GroupAutoApprove = {
  rows: { ...GROUP_REQUEST_DEFAULTS },
  allowEdits: true,
  worktree: COPY,
  ignored: [],
  ownBranch: 'fix-PROJ-77/review',
  shellCwd: COPY,
  tree: { dirty: false },
  parentChatId: 'p',
  groupIndex: 0,
};
const kind = (command: string): string => groupCommandVerdict(command, SCOPE).kind;
const decide = (command: string): string =>
  groupDecision(GROUP, { toolName: 'Bash', input: { command }, guardedPatterns: [] });
const at = (dir: string): string => `C="${fwd(dir)}"; cd "$C" && `;

/** Живой вызов D-5: проба через копию скрипта, запуск, удаление копии. */
const D5 = (dir: string): string =>
  `${at(dir)}grep -n "x" scripts/check_content.mjs && node -e 'const fs=require("fs");let s=fs.readFileSync("scripts/check_content.mjs","utf8");fs.writeFileSync("scripts/check_content.probe.mjs",s)' && node scripts/check_content.probe.mjs 2>&1 | grep PROBE; rm scripts/check_content.probe.mjs`;

describe('клон review-plan по метке — пробный каталог рецензента', () => {
  it.each([
    ['живой D-5: проба и rm её копии в клоне', D5(SUB)],
    [
      'git checkout -- файла в клоне после cd',
      `${at(SUB)}git checkout -- content/a.mdx; git status --short`,
    ],
    ['git -C <клон> checkout -- .', `git -C "${fwd(CLONE)}" checkout -- .`],
    ['git -C <клон без ссылок> clean -fdx', `git -C "${fwd(BARE)}" clean -fdx`],
    ['rm -f файла пробы по абсолютному пути', `rm -f "${fwd(SUB)}/scripts/x.probe.mjs"`],
    ['запись пробы в клон', `echo x > "${fwd(SUB)}/scripts/p.mjs"`],
    ['rm -f пробы в клоне с названной ссылкой', `rm -f "${fwd(LISTED)}/x.probe.mjs"`],
  ])('само: %s', (_name, command) => {
    expect(kind(command)).not.toBe('danger');
    expect(decide(command)).toBe('auto');
  });

  it.each([
    ['каталог без метки во временном', D5(join(UNMARKED, 'inst-docs-ui'))],
    ['git без метки во временном', `cd "${fwd(UNMARKED)}" && git checkout -- .`],
    ['битая метка', `rm -f "${fwd(BAD)}/x.probe.mjs"`],
    ['метка с source — сам каталог', `rm -f "${fwd(SELF)}/x.probe.mjs"`],
    ['метка без head', `rm -f "${fwd(HEADLESS)}/x.probe.mjs"`],
    ['внутри пути, названного ссылкой плана', `rm -rf "${fwd(LISTED)}/deps/pkg"`],
    ['через ссылку клона, не названную планом', `rm -rf "${fwd(LISTED)}/ext/pkg"`],
    ['через ссылку клона в настоящие зависимости', `rm -rf "${fwd(SUB)}/node_modules/pkg"`],
    ['предок клона', `rm -rf "${fwd(join(T, 'claude-review'))}"`],
    ['сам клон, пока жива ссылка плана', `rm -rf "${fwd(CLONE)}"`],
    ['git clean в клоне с живой ссылкой плана', `git -C "${fwd(CLONE)}" clean -fdx`],
    ['подъём из клона наружу', `rm -rf "${fwd(CLONE)}/../../other"`],
  ])('человеку: %s', (_name, command) => {
    expect(kind(command)).toBe('danger');
    expect(decide(command)).toBe('human');
  });

  it('запись: в клон — рутина; через его ссылку наружу — как вне копии без метки', () => {
    expect(kind(`echo x > "${fwd(SUB)}/scripts/p.mjs"`)).toBe('routine');
    const outside = kind(`echo x > "${fwd(UNMARKED)}/p.mjs"`);
    expect(outside).not.toBe('routine');
    expect(kind(`echo x > "${fwd(SUB)}/node_modules/pkg.js"`)).toBe(outside);
  });

  it('метка в основной копии, в предке копии и дома — не пробный каталог', () => {
    const marks = [MAIN, T, HOME];
    const previous = process.env.USERPROFILE;
    const previousHome = process.env.HOME;
    process.env.USERPROFILE = HOME;
    process.env.HOME = HOME;
    try {
      for (const dir of marks)
        mark(dir, JSON.stringify({ source: join(T, 'elsewhere'), head: 'a' }));
      expect(kind(`rm -f "${fwd(MAIN)}/src/x.ts"`)).toBe('danger');
      expect(kind(`cd "${fwd(MAIN)}" && git checkout -- .`)).toBe('danger');
      expect(kind(`rm -f "${fwd(T)}/loose/x.ts"`)).toBe('danger');
      expect(kind(`rm -f "${fwd(HOME)}/notes.txt"`)).toBe('danger');
      // Клон с собственной меткой ниже — по-прежнему пробный: решает ближайшая метка.
      expect(kind(`rm -f "${fwd(SUB)}/scripts/x.probe.mjs"`)).not.toBe('danger');
    } finally {
      for (const dir of marks)
        rmSync(join(dir, '.git', 'review-plan-scratch.json'), { force: true });
      if (previous === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previous;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  /**
   * Каталог после `cd X` — X, только если `cd` точно исполнился и удался: дальше по той же
   * цепочке `&&`, или X есть на диске и `cd` не в ветке `||`, не после `&&` и не в теле `if`.
   * Иначе `cd <клон>/нет; rm -rf *` судился в клоне, а исполнялся бы в копии группы.
   */
  describe('каталог после cd X; — только если cd точно удался', () => {
    const GONE = `${fwd(SUB)}/missing`;
    it.each([
      ['cd в клон; rm пробы', `cd "${fwd(SUB)}"; rm -f scripts/x.probe.mjs`],
      ['cd в несуществующий && rm', `cd "${GONE}" && rm -f x.probe.mjs`],
      ['cd в клон || exit; rm', `cd "${fwd(SUB)}" || exit 1; rm -f scripts/x.probe.mjs`],
      ['if cd X; then rm; fi', `if cd "${fwd(SUB)}"; then rm -f scripts/x.probe.mjs; fi`],
      ['cd в клон без ссылок; git clean', `cd "${fwd(BARE)}"; git clean -fdx`],
      [
        'cd после закрытого if/elif и цикла',
        `if true; then :; elif false; then :; fi; for f in a; do :; done; cd "${fwd(SUB)}"; rm -f scripts/x.probe.mjs`,
      ],
    ])('само: %s', (_name, command) => {
      expect(kind(command)).not.toBe('danger');
      expect(decide(command)).toBe('auto');
    });

    it.each([
      ['cd в несуществующий; rm', `cd "${GONE}"; rm -rf *`],
      ['cd в несуществующий || true; rm', `cd "${GONE}" || true; rm -rf x`],
      ['cd в несуществующий && (a; b); rm', `cd "${GONE}" && (true; true); rm -rf *`],
      ['cd в ветке ||', `true || cd "${fwd(SUB)}"; rm -rf scripts`],
      ['cd после && и ;', `test -d x && cd "${fwd(SUB)}"; rm -rf scripts`],
      ['cd в теле if', `if false; then cd "${fwd(SUB)}"; fi; rm -rf scripts`],
      ['cd глубже в теле цикла', `while false; do :; cd "${fwd(SUB)}"; done; rm -rf scripts`],
      ['a || cd X && rm', `true || cd "${fwd(SUB)}" && rm -rf scripts`],
      ['cd в несуществующий каталог клона; git clean', `cd "${fwd(BARE)}/missing"; git clean -fdx`],
      ['cd в клон в ветке ||; git clean', `true || cd "${fwd(BARE)}"; git clean -fdx`],
    ])('человеку: %s', (_name, command) => {
      expect(kind(command)).toBe('danger');
      expect(decide(command)).toBe('human');
    });
  });
});
