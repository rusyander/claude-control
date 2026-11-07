import { LINT_RULES, type UserLayerInventory } from '@agentdeck/contracts/core/user-layer';
import { describe, expect, it } from 'vitest';
import { launchLint } from './launch-lint.ts';
import { PROCESS_RULES } from './lint-rules.ts';

/**
 * G-h, 06:121-129 — линт запуска: строки слоя человека, просящие процесс ядра (push, MR/PR,
 * ожидание CI, весь набор, merge, approve), по-английски и по-русски, в прозе и в коде, с
 * номером строки (LF и CRLF одинаково) и тем, что ядро делает вместо; лишние ключи frontmatter
 * навыка — правилом `frontmatter-key` на строке ключа. Текст под маской вызывающего, ≤ 200.
 */

const EMPTY: UserLayerInventory = {
  cli: 'cli',
  hash: 'h',
  sources: [],
  hooks: [],
  skills: [],
  agents: [],
  unread: [],
};

const id = (t: string): string => t;

const rulesOf = (text: string): string[] =>
  launchLint(EMPTY, [{ path: 'CLAUDE.md', text }], id).map((w) => w.rule);

describe('G-h launch lint (conductor/lint)', () => {
  it('every process rule fires on its English and Russian wording and on the command inside a code span', () => {
    const cases: [string, string][] = [
      ['push', 'After the fix, git push the branch.'],
      ['push', 'Always push your changes to origin.'],
      ['push', 'Потом запушь ветку.'],
      ['push', 'Run `git push -u origin HEAD` at the end.'],
      ['push', 'When done, push straight to main.'],
      ['mr', 'Then open a merge request for review.'],
      ['mr', 'Use `gh pr create --fill`.'],
      ['mr', 'Создай MR в конце.'],
      ['ci-wait', 'Wait for the pipeline to finish.'],
      ['ci-wait', 'Run `gh run watch` until green.'],
      ['ci-wait', 'Дождись CI и только потом отчитывайся.'],
      ['whole-suite', 'Run the whole test suite before finishing.'],
      ['whole-suite', 'Прогони все тесты перед коммитом.'],
      ['merge', 'Merge the PR when it is green.'],
      ['merge', 'Finish with `glab mr merge`.'],
      ['merge', 'Смержи MR сам.'],
      ['approve', 'Approve the merge request if it looks fine.'],
      ['approve', 'Approve your own merge request if nobody answers.'],
      ['approve', 'Заапрувь его.'],
    ];
    for (const [rule, text] of cases) expect(rulesOf(text), text).toContain(rule);
    // Каждое правило процесса покрыто хотя бы одним случаем.
    expect(new Set(cases.map(([r]) => r))).toEqual(new Set(PROCESS_RULES.map((r) => r.rule)));
    expect(LINT_RULES.filter((r) => !PROCESS_RULES.some((d) => d.rule === r))).toEqual([
      'frontmatter-key',
    ]);
  });

  it('plain engineering text raises nothing (no false process lines)', () => {
    for (const text of [
      'Prefer small functions and name things clearly.',
      'Write tests for every bug you fix.',
      'Используй LF в окончаниях строк.',
      'Pushing state into a stack is fine.',
      'git merge-base is how we compute the diff base.',
    ])
      expect(rulesOf(text), text).toEqual([]);
  });

  it('line numbers count LF and CRLF the same; warning carries source, masked clipped text and the instead text', () => {
    const lf = 'intro\nsecond\nthen git push\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    const [a] = launchLint(EMPTY, [{ path: 'rules/a.md', text: lf }], id);
    const [b] = launchLint(EMPTY, [{ path: 'rules/a.md', text: crlf }], id);
    // Одиночный CR (старые редакторы) — тоже конец строки, иначе номер съезжает на 1.
    const [c] = launchLint(EMPTY, [{ path: 'rules/a.md', text: lf.replace(/\n/g, '\r') }], id);
    expect(a).toEqual(b);
    expect(c).toEqual(a);
    expect(a).toMatchObject({ rule: 'push', source: 'rules/a.md', line: 3, text: 'then git push' });
    expect(a?.instead).toContain('core publishes');
    const long = `git push ${'x'.repeat(400)} SECRET`;
    const [m] = launchLint(EMPTY, [{ path: 'p', text: long }], (t) => t.replace(/x/g, '*'));
    expect(m?.text.length).toBe(200);
    expect(m?.text).not.toContain('x');
    expect(m?.text).not.toContain('SECRET');
  });

  it('frontmatter keys the core does not read are flagged on the line of the key', () => {
    const inv: UserLayerInventory = {
      ...EMPTY,
      skills: [
        {
          name: 's',
          path: 'skills/s/SKILL.md',
          flow: null,
          extraKeys: ['agentdeck.model', 'when'],
        },
      ],
    };
    const text = '---\r\nname: s\r\nwhen: always\r\nagentdeck:\r\n  model: big\r\n---\r\nbody\r\n';
    const got = launchLint(inv, [{ path: 'skills/s/SKILL.md', text }], id).filter(
      (w) => w.rule === 'frontmatter-key',
    );
    expect(got.map((w) => [w.text, w.line])).toEqual([
      ['agentdeck.model', 4],
      ['when', 3],
    ]);
  });
});
