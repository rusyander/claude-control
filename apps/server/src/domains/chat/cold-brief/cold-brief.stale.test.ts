import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { coldBriefFacts } from './cold-brief.ts';
import { shaTokens } from './notebook-vs-git.ts';
import { TASK_TICKETS } from '../task-tickets/task-tickets.ts';

/**
 * F-11 (g0 25.10, вводная прогона 2): PROGRESS.md писался до rebase и push и говорил
 * «Local, NOT pushed: …», «BLOCKED: origin/main … конфликтует», а «Your last answer»
 * рядом — обратное. Настоящий git во временном каталоге: origin, клон-копия, rebase,
 * push — ничего из того, что сверка читает, не подменено.
 */
describe('вводная сверяет заметку состояния с git (F-11)', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const short = (cwd: string, ref: string) => git(cwd, 'rev-parse', '--short=10', ref).trim();
  const commit = (cwd: string, file: string, text: string, message: string) => {
    writeFileSync(join(cwd, file), text);
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-q', '-m', message);
  };

  /** Копия с двумя своими коммитами, не запушенными; на main origin — новый коммит. */
  function setup() {
    dir = mkdtempSync(join(tmpdir(), 'cold-brief-stale-'));
    const origin = join(dir, 'origin');
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    git(origin, 'config', 'user.email', 't@example.com');
    git(origin, 'config', 'user.name', 't');
    commit(origin, 'a.txt', 'base\n', 'base');
    const copy = join(dir, 'copy');
    git(dir, 'clone', '-q', origin, copy);
    git(copy, 'config', 'user.email', 't@example.com');
    git(copy, 'config', 'user.name', 't');
    git(copy, 'checkout', '-q', '-b', 'split/fix');
    commit(copy, 'b.txt', 'one\n', 'group: one');
    commit(copy, 'c.txt', 'two\n', 'group: two');
    commit(origin, 'm.txt', 'main moved\n', 'main: GOR-1650');
    git(copy, 'fetch', '-q');
    const own = [short(copy, 'HEAD~1'), short(copy, 'HEAD')] as const;
    const target = short(copy, 'origin/main');
    mkdirSync(join(copy, '.agent'));
    const progress =
      `Local, NOT pushed: ${own[0]} + ${own[1]}\n` +
      `BLOCKED: origin/main ${target} really conflicts — rebase guard refuses\n`;
    writeFileSync(join(copy, '.agent', 'PROGRESS.md'), progress);
    const transcript = join(dir, 's.jsonl');
    writeFileSync(transcript, '');
    return { copy, own, target, transcript };
  }

  it('после rebase и push: свои коммиты названы переписанными, заметка — STALE', () => {
    const { copy, own, target, transcript } = setup();
    git(copy, 'rebase', '-q', 'origin/main');
    git(copy, 'push', '-q', '-u', 'origin', 'split/fix');
    const facts = coldBriefFacts(copy, transcript);
    const section = facts.slice(facts.indexOf('## Notebook .agent/PROGRESS.md'));
    expect(section).toContain(
      `no longer on any branch (rewritten by a rebase/amend/reset after this was written): ${own[0]}, ${own[1]}`,
    );
    expect(section).toContain(`already on origin/split/fix: ${target}`);
    expect(section).toContain('This notebook is STALE');
    // Строка сверки стоит под заметкой, до коммитов ветки.
    expect(facts.indexOf('This notebook is STALE')).toBeLessThan(facts.indexOf('## Commits on'));
  });

  it('заметка верна (rebase ещё не было) — строки сверки нет', () => {
    const { copy, transcript } = setup();
    const facts = coldBriefFacts(copy, transcript);
    expect(facts).toContain('Local, NOT pushed:');
    expect(facts).not.toContain('Checked against git now');
  });

  it('запушено без переписывания — только факт, без вердикта STALE', () => {
    const { copy, own, transcript } = setup();
    git(copy, 'push', '-q', '-u', 'origin', 'split/fix');
    const facts = coldBriefFacts(copy, transcript);
    expect(facts).toContain(
      `(Checked against git now — already on origin/split/fix: ${own[0]}, ${own[1]}.)`,
    );
    expect(facts).not.toContain('STALE');
  });

  it('ветка слежения не настроена — ищется origin/<ветка>', () => {
    const { copy, own, transcript } = setup();
    git(copy, 'push', '-q', 'origin', 'split/fix');
    expect(coldBriefFacts(copy, transcript)).toContain(
      `already on origin/split/fix: ${own[0]}, ${own[1]}`,
    );
  });

  it('отсоединённый HEAD: свой коммит без ветки не назван переписанным', () => {
    const { copy, transcript } = setup();
    git(copy, 'checkout', '-q', '--detach');
    commit(copy, 'd.txt', 'detached\n', 'group: on detached HEAD');
    writeFileSync(join(copy, '.agent', 'PROGRESS.md'), `Local: ${short(copy, 'HEAD')}\n`);
    expect(coldBriefFacts(copy, transcript)).not.toContain('Checked against git now');
  });

  it('тикеты не сверяются: это не заметка состояния', () => {
    const { copy, own, transcript } = setup();
    writeFileSync(join(copy, '.agent', 'PROGRESS.md'), 'nothing about commits\n');
    mkdirSync(join(copy, TASK_TICKETS, '..'), { recursive: true });
    writeFileSync(join(copy, TASK_TICKETS), `ticket mentions ${own[0]}\n`);
    git(copy, 'rebase', '-q', 'origin/main');
    expect(coldBriefFacts(copy, transcript)).not.toContain('Checked against git now');
  });

  it('чужой CLI (read): та же сверка — она от git, не от транскрипта', () => {
    const { copy, own, transcript } = setup();
    git(copy, 'rebase', '-q', 'origin/main');
    const facts = coldBriefFacts(copy, transcript, undefined, { lastAnswer: 'rebased, pushed' });
    expect(facts).toContain(`rewritten by a rebase/amend/reset after this was written): ${own[0]}`);
  });

  it('слова-sha: цифра и буква обязательны, не больше предела', () => {
    expect(shaTokens('20261025 defaced 1a2b3c4 ABCDEF12 9f8e7d6c5b')).toEqual([
      '1a2b3c4',
      '9f8e7d6c5b',
    ]);
    const many = Array.from({ length: 20 }, (_, index) => `abc${String(index).padStart(4, '0')}`);
    expect(shaTokens(many.join(' '))).toHaveLength(12);
  });
});
