import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matchText } from '../../../lib/server-texts/server-texts.ts';
import { fromAdf } from '../../integrations/atlassian/adf.ts';
import type { MrReview } from '../../integrations/mr-review/mr-review.ts';
import { TASK_TICKETS } from '../task-tickets/task-tickets.ts';
import { deliveryFacts } from './delivery-check.ts';
import { mentionsMr } from './tracker-comments.ts';

/**
 * Задачи трекера в проверке доставки (split d9869abf): g3 перевела четыре задачи и не
 * оставила в них ни одного комментария со ссылкой на MR, а пункт владельца о нём сдала
 * «pass» по статусу (аудит g0–g4, R7); g8 перевела в Review задачу, которую сама
 * пропустила, — по списку всех ключей группы (F4). Настоящие git (MR — служебная ссылка
 * GitLab в голом репозитории) и сама проверка; подменены только сеть форджа и трекера.
 */

const WEB = 'https://git.example.com/team/app';
const MR = `${WEB}/-/merge_requests/1101`;
const WORK = '2026-10-25T09:00:00.000Z';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_DATE: WORK, GIT_COMMITTER_DATE: WORK },
  }).trim();
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

const review: MrReview = {
  state: 'open',
  author: 'rustam',
  description: '## Проверки\npnpm test — зелёный на итоговом коммите\n',
  threads: [],
};

const codes = (lines: readonly string[] | undefined) =>
  (lines ?? []).map((line) => matchText(line)?.messageCode);

describe('задачи трекера в проверке доставки', { timeout: 60_000 }, () => {
  let root = '';
  let work = '';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-tracker-'));
    const bare = join(root, 'remote.git');
    work = join(root, 'work');
    mkdirSync(work);
    git(root, ['init', '-q', '--bare', '-b', 'main', bare]);
    git(work, ['init', '-q', '-b', 'main']);
    write(work, { 'README.md': 'seed\n' });
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'seed']);
    git(work, ['remote', 'add', 'origin', `${WEB}.git`]);
    git(work, ['config', `url.${bare.replace(/\\/g, '/')}.insteadOf`, `${WEB}.git`]);
    git(work, ['push', '-q', 'origin', 'main']);
    git(work, ['switch', '-q', '-c', 'fix/PROJ-1']);
    write(work, { 'lib/sum.ts': 'export const sum = 1;\n' });
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'fix(PROJ-1): sum of an empty list']);
    git(work, ['push', '-q', 'origin', 'fix/PROJ-1']);
    git(bare, ['update-ref', 'refs/merge-requests/1101/head', git(work, ['rev-parse', 'HEAD'])]);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const check = (comments: (key: string) => Promise<readonly string[]>, deliverAhead = false) => {
    const asked: string[] = [];
    return deliveryFacts({ path: work, branch: 'fix/PROJ-1', base: 'main' }, MR, [], {
      testsCommand: 'node tests-cli.mjs run',
      branchOfMr: async () => 'fix/PROJ-1',
      review: async () => review,
      ...(deliverAhead ? { deliverAhead } : {}),
      tracker: {
        keys: ['PROJ-1', 'PROJ-2'],
        comments: (key) => {
          asked.push(key);
          return comments(key);
        },
      },
    }).then((verdict) => ({ verdict, asked }));
  };

  it('в сделанной задаче нет комментария с MR — пробел называет её; пропущенную — заметка', async () => {
    const { verdict, asked } = await check(async () => ['Взял в работу']);
    expect(verdict.mr).toBe(MR);
    // PROJ-2 ни в одном коммите ветки: её комментарии не читаются и пробела нет.
    expect(asked).toEqual(['PROJ-1']);
    const gap = verdict.missing.find(
      (line) => matchText(line)?.messageCode === 'delivery-gap-tracker-comment',
    );
    expect(gap).toContain('PROJ-1');
    expect(gap).not.toContain('PROJ-2');
    expect(gap).toContain(MR);
    const skipped = (verdict.notes ?? []).find(
      (line) => matchText(line)?.messageCode === 'delivery-note-tickets-skipped',
    );
    expect(skipped).toContain('PROJ-2');
    expect(skipped).not.toContain('PROJ-1');
  });

  it('комментарий ссылается на MR номером «!1101» — пробела нет', async () => {
    const { verdict } = await check(async () => ['Сделано в MR !1101, проверить: открыть форму']);
    expect(codes(verdict.missing)).not.toContain('delivery-gap-tracker-comment');
  });

  it('трекер не ответил — не пробел, а заметка «не прочитаны»', async () => {
    const { verdict } = await check(async () => {
      throw new Error('503');
    });
    expect(codes(verdict.missing)).not.toContain('delivery-gap-tracker-comment');
    expect(codes(verdict.notes)).toContain('delivery-note-tracker-unread');
  });

  it('стадия ревью при доставке впереди — задачи не проверяются: MR ведёт доставка', async () => {
    const { verdict, asked } = await check(async () => [], true);
    expect(asked).toEqual([]);
    expect(codes(verdict.missing)).not.toContain('delivery-gap-tracker-comment');
  });
  // g0 26.10 (F3): строки следа задач судит та же проверка доставки — источник пункта по
  // описанию MR и заданию группы, переписанное без коммита по времени HEAD настоящей копии.
  it('след задач: без источника, цитата мимо текстов, переписанное без коммита — пробелы доставки', async () => {
    const quote = '«пустой список суммируется в ноль»';
    const verdict = await deliveryFacts(
      {
        path: work,
        branch: 'fix/PROJ-1',
        base: 'main',
        taskTrace: true,
        sieveRows: [
          { id: 'task-1', status: 'pass', evidence: `${quote} — lib/sum.ts:1` },
          { id: 'task-2', status: 'pass', evidence: 'lib/sum.ts in the diff, tests green' },
          { id: 'task-3', status: 'pass', evidence: '«правка с тестами для суммы» — lib/sum.ts:1' },
          {
            id: 'task-4',
            status: 'pass',
            evidence: `${quote} — по описанию MR, кода нет`,
            // Прежняя сдача позже коммита HEAD (WORK, 09:00Z) — коммита после неё нет.
            rewrote: { evidence: `${quote} — lib/sum.ts:1 и тест`, at: '2026-10-25T10:00:00.000Z' },
          },
        ],
      },
      MR,
      [],
      {
        testsCommand: 'node tests-cli.mjs run',
        branchOfMr: async () => 'fix/PROJ-1',
        review: async () => review,
        taskTexts: ['PROJ-1: пустой список суммируется в ноль'],
      },
    );
    const gaps = verdict.missing.filter((line) =>
      (matchText(line)?.messageCode ?? '').startsWith('delivery-gap-task-'),
    );
    expect(codes(gaps)).toEqual([
      'delivery-gap-task-unsourced',
      'delivery-gap-task-quote-unfound',
      'delivery-gap-task-rewritten',
    ]);
    expect(gaps[0]).toContain('task-2');
    expect(gaps[1]).toContain('task-3');
    expect(gaps[2]).toContain('task-4');
  });

  // g5 27.10 (H1): 7 строк на 37 пунктов — PDF из комментария владельца не назвала ни одна
  // строка, а доставка судила только сданные. Пункт тикета из файла задач настоящей копии
  // без строки `task-N` — пробел доставки.
  it('пункт тикета без строки task-N — пробел доставки с ключом и пунктом', async () => {
    write(work, {
      [TASK_TICKETS]: [
        '## PROJ-1 — Сумма пустого списка',
        '* Пустой список суммируется в ноль',
        '* Нужен PDF «Отчёт для дизайна» к задаче',
        '',
      ].join('\n'),
    });
    try {
      const verdict = await deliveryFacts(
        {
          path: work,
          branch: 'fix/PROJ-1',
          base: 'main',
          taskTrace: true,
          sieveRows: [
            {
              id: 'task-1',
              status: 'pass',
              evidence: 'PROJ-1 «пустой список суммируется в ноль» — lib/sum.ts:1',
            },
          ],
        },
        MR,
        [],
        {
          testsCommand: 'node tests-cli.mjs run',
          branchOfMr: async () => 'fix/PROJ-1',
          review: async () => review,
        },
      );
      const gaps = verdict.missing.filter(
        (line) => matchText(line)?.messageCode === 'delivery-gap-task-point-unmapped',
      );
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toContain('PROJ-1');
      expect(gaps[0]).toContain('«Нужен PDF «Отчёт для дизайна» к задаче»');
      expect(gaps[0]).not.toContain('Пустой список');
    } finally {
      rmSync(join(work, TASK_TICKETS), { force: true });
    }
  });
});

describe('ссылка комментария на MR', () => {
  it('адрес без схемы, «!N» у GitLab, «#N» у GitHub; чужой номер — нет', () => {
    expect(mentionsMr('см. git.example.com/team/app/-/merge_requests/1101', MR)).toBe(true);
    expect(mentionsMr('MR 1101 влит', MR)).toBe(true);
    expect(mentionsMr('см. !11010', MR)).toBe(false);
    expect(mentionsMr('см. #1101', MR)).toBe(false);
    expect(mentionsMr('PR #7 merged', 'https://github.com/o/r/pull/7')).toBe(true);
    expect(mentionsMr('PR #70 merged', 'https://github.com/o/r/pull/7')).toBe(false);
  });

  it('ссылка-карточка облачной Jira читается адресом', () => {
    const body = fromAdf({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Сделано: ' },
            { type: 'inlineCard', attrs: { url: MR } },
          ],
        },
      ],
    });
    expect(body).toBe(`Сделано: ${MR}`);
    expect(mentionsMr(body ?? '', MR)).toBe(true);
  });

  // Живой ответ Jira Server 26.10 (GOR-1063): вики-разметка экранирует «_» в адресе —
  // «merge\_requests/827»; без снятия экранирования настоящая ссылка читалась пробелом.
  it('вики-разметка Jira Server: экранированный адрес — та же ссылка', () => {
    const wiki =
      '*Для QA*\n\nMR: https://git.example.com/team/app/-/merge\\_requests/1101\n\nПроверка: …';
    expect(mentionsMr(wiki, MR)).toBe(true);
    expect(mentionsMr('[MR|https://git.example.com/team/app/-/merge\\_requests/1101]', MR)).toBe(
      true,
    );
    expect(mentionsMr('MR: https://git.example.com/team/app/-/merge\\_requests/11010', MR)).toBe(
      false,
    );
  });
});
