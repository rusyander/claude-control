import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { deliverStagePrompt } from '@agentdeck/contracts/model-cascade';
import { deliveryPreamble } from '@agentdeck/contracts/task-split';

/**
 * Отправленная ветка группы отстала от основной (решение владельца, W3-3):
 * звено доставки переносит её на свежую основную и отправляет
 * `--force-with-lease` — только СВОЮ ветку. Раньше задание запрещало переписывать
 * отправленную историю, и звено стояло с вопросом на каждой отставшей группе.
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

/** Исполнить команду из задания: `<основная>` — имя основной, как его назвал бы агент. */
function runFromPrompt(cwd: string, command: string, main: string): string {
  const args = command.replace('<основная>', main).split(/\s+/).slice(1);
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

  it('rebase и пуш из задания проходят: ветка на удалённом стоит на свежей основной', () => {
    const prompt = deliverStagePrompt({ branch: BRANCH, after: 'fix' });
    const commands = commandsOf(prompt);
    const mainBefore = git(origin, 'rev-parse', 'main').trim();

    runFromPrompt(copy, 'git fetch origin', 'main');
    const head = git(copy, 'symbolic-ref', 'refs/remotes/origin/HEAD').trim();
    const main = head.replace('refs/remotes/origin/', '');
    const rebase = commands.find((command) => command.startsWith('git rebase origin/'));
    expect(rebase).toBeDefined();
    runFromPrompt(copy, rebase ?? '', main);
    // Пуш отправленной ветки после rebase — тот, что задание велит для этого случая.
    const pushes = commands.filter((command) => command.startsWith('git push'));
    const push = pushes.find((command) => command.includes('--force-with-lease')) ?? pushes[0];
    runFromPrompt(copy, push ?? '', main);

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
    expect(prompt).toContain('только свою ветку группы');
    expect(prompt).toContain('никогда основную, защищённую или ветку другой группы');
  });

  it('конфликт такого rebase — вопрос человеку, а не решение звена', () => {
    const prompt = deliverStagePrompt({ branch: BRANCH, after: 'fix' });

    expect(prompt).toMatch(/конфликт этого rebase: [^\n]*AskUserQuestion/);
    expect(prompt).toContain('git rebase --abort');
  });

  it('преамбула группы без звена доставки разрешает то же и так же узко', () => {
    const preamble = deliveryPreamble({ branch: BRANCH });

    expect(preamble).toContain('git push --force-with-lease origin <ветка группы>');
    expect(preamble).toContain('никогда основную, защищённую или ветку другой группы');
    expect(preamble).toMatch(/конфликт при таком rebase — вопрос человеку/);
    expect(preamble).not.toContain('Слияние, удаление веток и force-push по-прежнему запрещены');
  });

  it('чужому CLI — вопрос человеку без инструмента, которого у него нет', () => {
    const prompt = deliverStagePrompt({ branch: BRANCH, after: 'fix', foreign: true });

    expect(prompt).not.toContain('AskUserQuestion');
    expect(prompt).toContain('git push --force-with-lease origin fix-PROJ-7');
  });
});
