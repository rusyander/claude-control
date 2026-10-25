import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BRIEF_LAST_ANSWER_CHARS,
  BRIEF_NOTEBOOK_CHARS,
  BRIEF_NOTEBOOK_WHOLE,
  coldBriefFacts,
  interruptedStretch,
  lastAnswer,
} from './cold-brief.ts';
import { TASK_NOTEBOOK } from '../task-notebook/task-notebook.ts';
import { TASK_TICKETS } from '../task-tickets/task-tickets.ts';

/**
 * Вводная нового разговора вместо остывшего собирается панелью (директива L4):
 * настоящий git во временном каталоге, настоящий транскрипт-файл — ничего из
 * того, что вводная читает, не подменено.
 */
describe('coldBriefFacts', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  const answer = (text: string) =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

  /** Источник с веткой main и копия-клон с веткой группы, коммитом и правкой. */
  function copyWithWork(): { copy: string; transcript: string } {
    dir = mkdtempSync(join(tmpdir(), 'cold-brief-'));
    const origin = join(dir, 'origin');
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    git(origin, 'config', 'user.email', 't@example.com');
    git(origin, 'config', 'user.name', 't');
    writeFileSync(join(origin, 'a.txt'), 'base\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-q', '-m', 'base');
    const copy = join(dir, 'copy');
    git(dir, 'clone', '-q', origin, copy);
    git(copy, 'config', 'user.email', 't@example.com');
    git(copy, 'config', 'user.name', 't');
    git(copy, 'checkout', '-q', '-b', 'split/fix');
    writeFileSync(join(copy, 'b.txt'), 'group work\n');
    git(copy, 'add', '.');
    git(copy, 'commit', '-q', '-m', 'group: first fix');
    writeFileSync(join(copy, 'a.txt'), 'base\nedited\n');
    mkdirSync(join(copy, '.agent'));
    writeFileSync(join(copy, '.agent', 'PROGRESS.md'), 'done: fix 1; left: fix 2\n');
    const transcript = join(dir, 's.jsonl');
    writeFileSync(
      transcript,
      [
        answer('Первый ответ.'),
        answer('Итог стадии: одно замечание осталось.'),
        '{"type":"user"}',
      ].join('\n'),
    );
    return { copy, transcript };
  }

  it('заметки, коммиты от базы, правки от базы, незакоммиченное, последний ответ, путь', () => {
    const { copy, transcript } = copyWithWork();
    const facts = coldBriefFacts(copy, transcript);
    expect(facts).toContain('## Notebook .agent/PROGRESS.md');
    expect(facts).toContain('done: fix 1; left: fix 2');
    expect(facts).toMatch(
      /## Commits on split\/fix since origin\/HEAD\n[0-9a-f]+ group: first fix/,
    );
    // База — origin, а не начало истории: коммит источника в список не попал.
    expect(facts).not.toMatch(/[0-9a-f]+ base\n/);
    expect(facts).toContain('b.txt');
    expect(facts).toMatch(/## Uncommitted \(git status --short\)\n M a\.txt/);
    expect(facts).toContain('Итог стадии: одно замечание осталось.');
    expect(facts).not.toContain('Первый ответ.');
    expect(facts).toContain(`Previous transcript: ${transcript}`);
  });

  // F-25 ревью П1: группа с `after` отведена от ветки предшественника — его
  // коммиты не её работа, и от origin/HEAD вводная выдала бы их за её.
  it('копия от ветки предшественника считает коммиты и правки от неё', () => {
    const { copy, transcript } = copyWithWork();
    git(copy, 'stash', '-q');
    git(copy, 'checkout', '-q', '-b', 'split/next');
    writeFileSync(join(copy, 'c.txt'), 'next work\n');
    git(copy, 'add', 'c.txt');
    git(copy, 'commit', '-q', '-m', 'next: own fix');
    const facts = coldBriefFacts(copy, transcript, 'split/fix');
    expect(facts).toMatch(/## Commits on split\/next since split\/fix\n[0-9a-f]+ next: own fix/);
    expect(facts).not.toContain('group: first fix');
    expect(facts).toMatch(/## Changed vs split\/fix \(git diff --stat\)\n c\.txt/);
    expect(facts).not.toMatch(/ b\.txt/);
    // Ветки предшественника в копии нет — база прежняя, origin.
    expect(coldBriefFacts(copy, transcript, 'split/gone')).toContain('since origin/HEAD');
  });

  // F-06: панель сама ведёт блокнот группы и тикеты в `.agent/run/` — именно там
  // лежат решения стадий; без них новая сессия перечитывает всё заново.
  it('блокнот группы и тикеты из .agent/run едут в вводную первыми', () => {
    const { copy, transcript } = copyWithWork();
    mkdirSync(join(copy, '.agent', 'run'));
    writeFileSync(join(copy, TASK_NOTEBOOK), 'decision: keep the old API\n');
    writeFileSync(join(copy, TASK_TICKETS), 'PROJ-1: login fails on Safari\n');
    const facts = coldBriefFacts(copy, transcript);
    expect(facts).toContain(`## Notebook ${TASK_NOTEBOOK}\ndecision: keep the old API`);
    expect(facts).toContain(`## Notebook ${TASK_TICKETS}\nPROJ-1: login fails on Safari`);
    const order = [TASK_NOTEBOOK, TASK_TICKETS, '.agent/PROGRESS.md'].map((rel) =>
      facts.indexOf(`## Notebook ${rel}`),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('длинные заметки и ответ обрезаны с пометкой; не репозиторий и нет заметок — разделов нет', () => {
    dir = mkdtempSync(join(tmpdir(), 'cold-brief-'));
    mkdirSync(join(dir, '.agent'));
    writeFileSync(join(dir, '.agent', 'PROGRESS.md'), 'x'.repeat(BRIEF_NOTEBOOK_WHOLE + 50));
    const transcript = join(dir, 's.jsonl');
    writeFileSync(transcript, answer('y'.repeat(BRIEF_LAST_ANSWER_CHARS + 50)));
    const facts = coldBriefFacts(dir, transcript);
    // Обрез называет, где остаток: «не собирай заново» в шапке не значит «не дочитывай».
    expect(facts).toContain(
      `…(cut at ${BRIEF_NOTEBOOK_CHARS} chars — read the rest of .agent/PROGRESS.md yourself before acting)`,
    );
    expect(facts).toContain(
      `…(cut at ${BRIEF_LAST_ANSWER_CHARS} chars — the rest is the last answer in the previous transcript)`,
    );
    expect(facts).not.toContain('## Commits');
    expect(facts).not.toContain('## Uncommitted');
    expect(facts).not.toContain('notes.md');
  });

  it('заметки ≤ 8k — целиком; длиннее — по строке, с номером строки остатка (группа 1, 25.10)', () => {
    dir = mkdtempSync(join(tmpdir(), 'cold-brief-'));
    mkdirSync(join(dir, '.agent'));
    const progress = Array.from({ length: 160 }, (_, i) => `- шаг ${i}: ${'п'.repeat(30)}`);
    const transcript = join(dir, 's.jsonl');
    writeFileSync(transcript, answer('итог'));
    // 6,4k — как PROGRESS.md группы 1: раньше 4k текстом и «дочитай сам» → файл заново целиком.
    writeFileSync(join(dir, '.agent', 'PROGRESS.md'), progress.join('\n'));
    const whole = coldBriefFacts(dir, transcript);
    expect(whole).toContain('- шаг 159:');
    expect(whole).not.toContain('…(');
    // Длиннее 8k — обрез на границе строки и строка, с которой читать.
    const long = Array.from({ length: 320 }, (_, i) => `- шаг ${i}: ${'п'.repeat(30)}`);
    writeFileSync(join(dir, '.agent', 'PROGRESS.md'), long.join('\n'));
    const cut = coldBriefFacts(dir, transcript);
    const shown =
      /…\(lines 1–(\d+) of 320 shown — read the rest of \.agent\/PROGRESS\.md from line (\d+) \(Read offset=(\d+)\)/.exec(
        cut,
      );
    expect(shown).not.toBeNull();
    expect(Number(shown![2])).toBe(Number(shown![1]) + 1);
    expect(shown![3]).toBe(shown![2]);
    // Строка `from line N` — первая НЕ показанная: показанная последней — N−1.
    const from = Number(shown![2]);
    expect(cut).toContain(`${long[from - 2]}\n…(lines`);
    expect(cut).not.toContain(long[from - 1]);
  });

  it('шапка фактов — с отметкой времени и «git только о том, что после»', () => {
    dir = mkdtempSync(join(tmpdir(), 'cold-brief-'));
    const transcript = join(dir, 's.jsonl');
    writeFileSync(transcript, answer('итог'));
    expect(coldBriefFacts(dir, transcript)).toMatch(
      /^Facts the panel collected for you at \d{4}-\d\d-\d\dT[\d:.]+Z — current as of then; do not collect them again, run git only for what changed after:/,
    );
  });

  it('оборванный ход: найденное между вызовами едет в вводную, «последний ответ» не дублирует', () => {
    dir = mkdtempSync(join(tmpdir(), 'cold-brief-'));
    const transcript = join(dir, 's.jsonl');
    const tool = (id: string, text?: string) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            ...(text ? [{ type: 'text', text }] : []),
            { type: 'tool_use', id, name: 'Bash', input: { command: 'x' } },
          ],
        },
      });
    const result = (id: string) =>
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
      });
    const human = JSON.stringify({ type: 'user', message: { content: 'почини зависание' } });
    writeFileSync(
      transcript,
      [
        answer('СТАРЫЙ-ИТОГ прошлого хода'),
        human,
        tool('t1', 'Смотрю профиль.'),
        result('t1'),
        tool('t2', 'ПРИЧИНА: cpSync копирует node_modules, 68,5 с.'),
        result('t2'),
        tool('t3', 'Запускаю ещё раз.'),
        result('t3'),
        tool('t4'),
      ].join('\n'),
    );
    expect(interruptedStretch(transcript)).toContain('ПРИЧИНА: cpSync');
    const facts = coldBriefFacts(dir, transcript);
    expect(facts).toContain('## The previous turn broke off mid-work');
    expect(facts).toContain('ПРИЧИНА: cpSync копирует node_modules, 68,5 с.');
    expect(facts).not.toContain('СТАРЫЙ-ИТОГ');
    expect(facts).not.toContain('## Your last answer');
    // Ход кончился итогом — раздела нет, итог — «последним ответом», как было.
    writeFileSync(
      transcript,
      [human, tool('t1', 'Смотрю.'), result('t1'), answer('ИТОГ')].join('\n'),
    );
    expect(interruptedStretch(transcript)).toBe('');
    expect(coldBriefFacts(dir, transcript)).toContain(
      '## Your last answer in the previous conversation\nИТОГ',
    );
  });

  it('последний ответ — последний НЕпустой текст модели, не реплика человека', () => {
    dir = mkdtempSync(join(tmpdir(), 'cold-brief-'));
    const transcript = join(dir, 's.jsonl');
    writeFileSync(
      transcript,
      [
        answer('Нужный итог.'),
        JSON.stringify({ type: 'assistant', message: { content: [] } }),
      ].join('\n'),
    );
    expect(lastAnswer(transcript)).toBe('Нужный итог.');
  });

  it('неотвеченный AskUserQuestion едет в вводную с вариантами; отвеченный — нет', () => {
    dir = mkdtempSync(join(tmpdir(), 'cold-brief-'));
    const transcript = join(dir, 's.jsonl');
    const ask = (question: string) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Нужно решение.' },
            {
              type: 'tool_use',
              name: 'AskUserQuestion',
              input: {
                questions: [{ question, options: [{ label: 'Слить' }, { label: 'Оставить' }] }],
              },
            },
          ],
        },
      });
    writeFileSync(transcript, ask('Сливать дубли?'));
    expect(coldBriefFacts(dir, transcript)).toContain(
      '## Your question still open in the previous conversation (the message below may answer it)\n' +
        '- Сливать дубли? Options: Слить | Оставить',
    );

    writeFileSync(
      transcript,
      [ask('Сливать дубли?'), JSON.stringify({ type: 'user', message: { content: 'Слить' } })].join(
        '\n',
      ),
    );
    expect(coldBriefFacts(dir, transcript)).not.toContain('still open');
  });
});
