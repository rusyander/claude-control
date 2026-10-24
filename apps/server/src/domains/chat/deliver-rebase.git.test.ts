import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { deliverStagePrompt } from '@agentdeck/contracts/model-cascade';
import { deliveryPreamble } from '@agentdeck/contracts/task-split';

/**
 * Отправленная ветка группы отстала от основной. С 20.10 (владелец 19.10,
 * MUST #1) её переносят ТОЛЬКО при настоящем конфликте с основной: без него
 * брокер откажет в rebase, а перенос гнал бы гейт заново. При конфликте звено
 * переносит её и отправляет `--force-with-lease` — только СВОЮ ветку (W3-3).
 *
 * Команды берутся ИЗ ТЕКСТА задания и исполняются на настоящем git с голым
 * удалённым: проверяется не формулировка, а то, что сказанное агенту проходит.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function commit(dir: string, files: Record<string, string>, message: string): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git(dir, 'add', '.');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message);
}

/** Команды git из задания — всё, что стоит в обратных кавычках и начинается с `git `. */
function commandsOf(prompt: string): string[] {
  return [...prompt.matchAll(/`(git [^`]+)`/g)].map((match) => match[1] ?? '');
}

/** Исполнить команду из задания: `<main>` — имя основной, как его назвал бы агент. */
function runFromPrompt(cwd: string, command: string, main: string): string {
  const args = command.replace('<main>', main).split(/\s+/).slice(1);
  return git(cwd, ...args);
}

const BRANCH = 'fix-PROJ-7';

describe('доставка отставшей отправленной ветки на настоящем git', () => {
  let root: string;
  let seed: string;
  let copy: string;
  let origin: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-deliver-rebase-'));
    origin = join(root, 'origin.git');
    seed = join(root, 'seed');
    copy = join(root, 'copy');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, seed);
    git(seed, 'checkout', '-q', '-b', 'main');
    commit(seed, { 'web/a.ts': 'a\n', 'api/x.go': 'x\n' }, 'base');
    git(seed, 'push', '-q', 'origin', 'main');
    // Копия группы: своя ветка, работа закоммичена и уже отправлена.
    git(root, 'clone', '-q', origin, copy);
    git(copy, 'checkout', '-q', '-b', BRANCH);
    commit(copy, { 'web/a.ts': 'a group\n' }, 'group work');
    git(copy, 'push', '-q', '-u', 'origin', BRANCH);
    // Пока группа шла ревью и правками, основная ушла вперёд.
    commit(seed, { 'api/x.go': 'x moved\n' }, 'main moved');
    git(seed, 'push', '-q', 'origin', 'main');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('без конфликта основную не догоняют: проверка из задания отвечает 0, ветка на своей базе', () => {
    const prompt = deliverStagePrompt({ branch: BRANCH, after: 'fix' });
    const commands = commandsOf(prompt);
    const mainBefore = git(origin, 'rev-parse', 'main').trim();
    const branchBefore = git(origin, 'rev-parse', BRANCH).trim();

    runFromPrompt(copy, 'git fetch origin', 'main');
    const check = commands.find((command) => command.startsWith('git merge-tree'));
    expect(check).toBeDefined();
    // Код 0 — execFileSync не бросает: конфликта нет, и задание велит стоять.
    runFromPrompt(copy, check ?? '', 'main');
    expect(prompt).toContain(
      'exit 0 and no CONFLICT line = no conflict: stay on the current base, never rebase',
    );

    expect(git(origin, 'rev-parse', BRANCH).trim()).toBe(branchBefore);
    expect(git(origin, 'rev-parse', 'main').trim()).toBe(mainBefore);
  }, 30_000);

  it('с конфликтом проверка отвечает 1, и rebase с пушем из задания проходят', () => {
    commit(seed, { 'web/a.ts': 'a main\n' }, 'main touched the same line');
    git(seed, 'push', '-q', 'origin', 'main');
    const prompt = deliverStagePrompt({ branch: BRANCH, after: 'fix' });
    const commands = commandsOf(prompt);
    const mainBefore = git(origin, 'rev-parse', 'main').trim();

    runFromPrompt(copy, 'git fetch origin', 'main');
    const check = commands.find((command) => command.startsWith('git merge-tree'));
    expect(() => runFromPrompt(copy, check ?? '', 'main')).toThrow();
    const rebase = commands.find((command) => command.startsWith('git rebase origin/'));
    expect(rebase).toBeDefined();
    // Агент решает конфликт; здесь — берём сторону группы и продолжаем.
    expect(() => runFromPrompt(copy, rebase ?? '', 'main')).toThrow();
    writeFileSync(join(copy, 'web/a.ts'), 'a group\n');
    git(copy, 'add', 'web/a.ts');
    execFileSync('git', ['-c', 'core.editor=true', 'rebase', '--continue'], {
      cwd: copy,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_EDITOR: 'true',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
    const pushes = commands.filter((command) => command.startsWith('git push'));
    const push = pushes.find((command) => command.includes('--force-with-lease')) ?? pushes[0];
    runFromPrompt(copy, push ?? '', 'main');

    // Удалённая ветка группы — поверх свежей основной, основная не тронута.
    git(origin, 'merge-base', '--is-ancestor', 'main', BRANCH);
    expect(git(origin, 'rev-parse', 'main').trim()).toBe(mainBefore);
    expect(git(origin, 'show', `${BRANCH}:api/x.go`)).toBe('x moved\n');
    expect(git(origin, 'show', `${BRANCH}:web/a.ts`)).toBe('a group\n');
  }, 30_000);
});

describe('задание доставки отставшей отправленной ветки: границы', () => {
  it('пуш с арендой называет только ветку группы — не основную и не чужую', () => {
    const prompt = deliverStagePrompt({ branch: BRANCH, after: 'review' });
    const leased = commandsOf(prompt).filter((command) => command.includes('--force-with-lease'));

    expect(leased).toEqual([`git push --force-with-lease origin ${BRANCH}`]);
    expect(prompt).toContain('only your own group branch');
    expect(prompt).toContain("never the main, a protected or another group's branch");
  });

  // Владелец 23.10: rebase и перезапись MR — только при конфликте и сами; конфликт
  // отправленной ветки, отданный человеку, держал MR до утра.
  it('конфликт rebase — до пуша и после — снимает сама группа, не человек', () => {
    const prompt = deliverStagePrompt({ branch: BRANCH, after: 'fix' });

    expect(prompt).toContain(
      'A rebase conflict within the tasks of the group — before or after the first push — is ' +
        'resolved by the group itself, never handed to the human',
    );
    expect(prompt).not.toMatch(/conflict of that rebase: [^\n]*AskUserQuestion/);
    expect(prompt).toContain('git rebase --abort');
  });

  it('преамбула группы без звена доставки разрешает то же и так же узко', () => {
    const preamble = deliveryPreamble({ branch: BRANCH });

    expect(preamble).toContain('git push --force-with-lease origin <group branch>');
    expect(preamble).toContain("never the main, a protected branch or another group's branch");
    expect(preamble).toMatch(
      /a conflict in such a rebase is resolved by the group itself, never handed to the human/,
    );
    expect(preamble).not.toContain('Merging, deleting branches and force-push are still forbidden');
  });

  it('чужому CLI — вопрос человеку без инструмента, которого у него нет', () => {
    const prompt = deliverStagePrompt({ branch: BRANCH, after: 'fix', foreign: true });

    expect(prompt).not.toContain('AskUserQuestion');
    expect(prompt).toContain('git push --force-with-lease origin fix-PROJ-7');
  });
});
