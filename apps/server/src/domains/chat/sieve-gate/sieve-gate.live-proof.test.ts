import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeSieveRows, type SieveReportRow } from '@agentdeck/contracts/sieves';
import { createGroup, upsertCase, writeRun } from '../../project-tests/project-tests.ts';
import { ownerCoverageGaps } from '../owner-coverage/owner-coverage.ts';
import { sieveDeliveryGaps } from './sieve-gate.ts';

/**
 * Живые сита и их доказательство на НАСТОЯЩЕМ git и настоящей истории блока «Тесты»
 * (g3 25.10, находки N2–N4 сторожа):
 * - N2 — прогон, названный свободно («в run ab12cd34»), не был ссылкой: группа слышала
 *   «нет прогона», хотя зелёный прогон лежал в истории; выдуманный номер — не ссылка;
 * - N3 — browser-focus и boundary-negative «доказывал» прогон юнит-кейса: живую проверку
 *   доказывает только прошедший кейс с живой меткой;
 * - N4 — fail → pass с тем же доказательством («красный только на Windows») молча
 *   становился зачётом — у сита и у пункта владельца.
 */

const SEED = '2026-01-01T10:00:00Z';
const STARTED = '2026-02-01T10:00:00Z';
const WORK = '2026-02-02T10:00:00Z';
const EARLIER = '2026-02-03T09:00:00.000Z';
const REPORTED = '2026-02-03T10:00:00.000Z';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[], date = SEED): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

function commit(root: string, files: Record<string, string>, date: string): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, ['add', '-A', '--', ...Object.keys(files)], date);
  git(root, ['commit', '-q', '-m', 'c'], date);
}

/** Копия группы на ветке `grp` с правкой интерфейса и одним кейсом блока «Тесты». */
function uiBranch(
  tags: string[],
  author: 'human' | 'agent' = 'human',
  at = WORK,
): { work: string; caseId: string } {
  const root = mkdtempSync(join(tmpdir(), 'sieve-live-'));
  dirs.push(root);
  const origin = join(root, 'origin.git');
  const main = join(root, 'main');
  const work = join(root, 'work');
  git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(root, ['clone', '-q', origin, main]);
  git(main, ['checkout', '-q', '-b', 'main']);
  commit(main, { 'src/Page.tsx': 'export const Page = 1;\n', 'e2e/page.spec.ts': '//\n' }, SEED);
  git(main, ['push', '-q', '-u', 'origin', 'main']);
  git(root, ['clone', '-q', origin, work]);
  git(work, ['checkout', '-q', '-b', 'grp']);
  commit(
    work,
    { 'src/Page.tsx': 'export const Page = 2;\n', 'e2e/page.spec.ts': '// focus\n' },
    WORK,
  );
  createGroup(work, 'page');
  const caseId = upsertCase(work, 'page', { title: 'Фокус', tags }, at, author).id;
  return { work, caseId };
}

function greenRun(work: string, caseId: string, id: string, at = REPORTED, attested = false): void {
  writeRun(work, {
    id,
    ...(attested ? { attested: true } : {}),
    mode: 'run',
    actor: 'agent',
    commit: git(work, ['rev-parse', '--short', 'HEAD']).trim(),
    status: 'done',
    startedAt: at,
    finishedAt: at,
    results: [{ pointId: `page:${caseId}`, groupId: 'page', caseId, status: 'passed' }],
    summary: { total: 1, passed: 1, failed: 0, skipped: 0, blocked: 0 },
  } as Parameters<typeof writeRun>[1]);
}

const row = (
  id: string,
  evidence: string,
  status: SieveReportRow['status'] = 'pass',
): SieveReportRow => ({ id, status, evidence, at: REPORTED });

/** Пробелы сита browser-focus при этой строке (соседние сита закрыты). */
async function focusGaps(work: string, focus: SieveReportRow | SieveReportRow[]) {
  const rows = Array.isArray(focus) ? focus : [focus];
  const gaps = await sieveDeliveryGaps({
    cwd: work,
    startedAt: STARTED,
    rows: [
      ...rows,
      row('boundary-negative', 'n/a: no input changed, only a constant'),
      row('tests-alongside', 'e2e/page.spec.ts covers it'),
    ],
  });
  return gaps.missing.filter((line) => line.includes('browser-focus')).join('\n');
}

describe('N2: прогон, названный свободно', () => {
  it('«в run <hex>» с настоящим зелёным прогоном — ссылка, сито снято', async () => {
    const { work, caseId } = uiBranch(['browser']);
    greenRun(work, caseId, 'ab12cd34ef');
    expect(
      await focusGaps(work, row('browser-focus', 'playwright focus passed в run ab12cd34ef')),
    ).toBe('');
  });

  it('прогона не назвал, а подходящий есть в истории — пробел называет его номер', async () => {
    const { work, caseId } = uiBranch(['browser']);
    greenRun(work, caseId, 'ab12cd34ef');
    const gaps = await focusGaps(
      work,
      row('browser-focus', 'npx playwright test focus → 3 passed'),
    );
    expect(gaps).toContain('прогон ab12cd34ef из истории блока «Тесты» уже подходит');
    expect(gaps).toContain('run:ab12cd34ef');
  });

  it('выдуманный свободный номер — не ссылка: пробел «нет прогона», а не «прогона нет в истории»', async () => {
    const { work } = uiBranch(['browser']);
    const gaps = await focusGaps(work, row('browser-focus', 'checked it, run deadbeef99 passed'));
    expect(gaps).toContain('живая проверка не подтверждена прогоном');
    expect(gaps).not.toContain('deadbeef99');
  });
});

describe('N3: живое сито доказывает только живой кейс', () => {
  it('зелёный прогон кейса без живой метки — пробел «нет живой проверки»', async () => {
    const { work, caseId } = uiBranch(['unit']);
    greenRun(work, caseId, 'run-unit-1');
    const gaps = await focusGaps(work, row('browser-focus', 'vitest Page → passed run:run-unit-1'));
    expect(gaps).toContain('в прогоне run-unit-1 нет живой проверки');
    expect(gaps).toContain('live, browser, e2e');
  });

  it('тот же прогон с кейсом-«browser» — снято', async () => {
    const { work, caseId } = uiBranch(['Browser']);
    greenRun(work, caseId, 'run-live-1');
    expect(
      await focusGaps(work, row('browser-focus', 'playwright focus → passed run:run-live-1')),
    ).toBe('');
  });
});

describe('N4: fail → pass без нового доказательства', () => {
  const RED = 'playwright focus: red only on Windows (path case) run:run-old-01';

  /** Строка прошлого круга и строка этого — тем же слиянием, что у конвейера. */
  const flipped = (before: SieveReportRow, after: SieveReportRow): SieveReportRow[] =>
    mergeSieveRows(mergeSieveRows([], [{ ...before, at: EARLIER }]), [after]);

  it('то же доказательство со словом «red» — пробел переворота, а не зачёт', async () => {
    const { work, caseId } = uiBranch(['browser']);
    greenRun(work, caseId, 'run-old-01');
    const rows = flipped(row('browser-focus', RED, 'fail'), row('browser-focus', RED));
    expect(rows[0]?.was).toEqual({ status: 'fail', evidence: RED });
    const gaps = await focusGaps(work, rows);
    expect(gaps).toContain('строка стала pass без нового доказательства');
    expect(gaps).toContain('доказательство и сейчас говорит «красный»');
  });

  it('тот же текст без слова «red» и без нового прогона — пробел «то же доказательство»', async () => {
    const { work, caseId } = uiBranch(['browser']);
    greenRun(work, caseId, 'run-old-01');
    const same = 'playwright focus on the page, tab order run:run-old-01';
    const gaps = await focusGaps(
      work,
      flipped(row('browser-focus', same, 'fail'), row('browser-focus', same)),
    );
    expect(gaps).toContain('с тем же доказательством');
  });

  it('pass с меткой «not checked:» — пробел: метка бывает только у fail', async () => {
    const { work } = uiBranch(['browser']);
    const gaps = await focusGaps(
      work,
      row('browser-focus', 'not checked: no stand with this branch'),
    );
    expect(gaps).toContain(
      'метки «not checked:» и «not caused by the branch:» ставятся только у fail',
    );
  });

  it('переворот с новым зелёным прогоном — принят', async () => {
    const { work, caseId } = uiBranch(['browser']);
    greenRun(work, caseId, 'run-new-02');
    const gaps = await focusGaps(
      work,
      flipped(
        row('browser-focus', RED, 'fail'),
        row('browser-focus', 'fixed the path case, playwright focus → passed run:run-new-02'),
      ),
    );
    expect(gaps).toBe('');
  });

  it('пункт владельца: тот же «красный только на Windows» после fail — пробел пункта', () => {
    const red = 'login form: red only on Windows, see run ac24faf5';
    const rows = mergeSieveRows(
      mergeSieveRows([], [{ ...row('owner-4', red, 'fail'), at: EARLIER }]),
      [row('owner-4', red)],
    );
    const gaps = ownerCoverageGaps(rows, true).join('\n');
    expect(gaps).toContain('пункт задания владельца owner-4: строка стала pass');
  });
});

describe('F2: живую метку доказывает не слово агента (split d9869abf, g8)', () => {
  it('ручная запись «passed» (attested) с кейсом-«browser» — пробел «нет живой проверки»', async () => {
    const { work, caseId } = uiBranch(['browser']);
    greenRun(work, caseId, 'run-attest-1', REPORTED, true);
    const gaps = await focusGaps(
      work,
      row('browser-focus', 'playwright focus → passed run:run-attest-1'),
    );
    expect(gaps).toContain('в прогоне run-attest-1 нет живой проверки');
  });

  it('кейс агента с меткой «browser», заведённый после начала группы, — пробел', async () => {
    const { work, caseId } = uiBranch(['browser'], 'agent', WORK);
    greenRun(work, caseId, 'run-own-1');
    const gaps = await focusGaps(
      work,
      row('browser-focus', 'playwright focus → passed run:run-own-1'),
    );
    expect(gaps).toContain('в прогоне run-own-1 нет живой проверки');
  });

  it('кейс агента, заведённый до начала группы, — метка в силе, сито снято', async () => {
    const { work, caseId } = uiBranch(['browser'], 'agent', SEED);
    greenRun(work, caseId, 'run-old-case-1');
    expect(
      await focusGaps(work, row('browser-focus', 'playwright focus → passed run:run-old-case-1')),
    ).toBe('');
  });
});
