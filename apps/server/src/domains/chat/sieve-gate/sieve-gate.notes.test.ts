import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SieveReportRow, SieveStatus } from '@agentdeck/contracts/sieves';
import type { ProjectTestStatus } from '@agentdeck/contracts';
import { createGroup, upsertCase, writeRun } from '../../project-tests/project-tests.ts';
import { NOTE_MARKS_LINE, sieveDeliveryGaps, sievePrompt } from './sieve-gate.ts';

/**
 * Заметки вместо пробелов (решение владельца 23.10: группа идёт до готового MR
 * сама, держит только сломанное веткой). Живая группа встала на «не пройдено:
 * нет бэкенда ветки на стенде» и на красном кейсе, красном и до неё. На
 * НАСТОЯЩЕМ git и настоящей истории блока «Тесты».
 */

const SEED = '2026-01-01T10:00:00Z';
const BASELINE = '2026-01-15T10:00:00.000Z';
const STARTED = '2026-02-01T10:00:00Z';
const WORK = '2026-02-02T10:00:00Z';
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

/** Ветка с правкой интерфейса; в блоке «Тесты» — кейс страницы и чужой кейс. */
function uiBranch(extra: Record<string, string> = {}): {
  work: string;
  page: string;
  other: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'sieve-notes-'));
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
    { 'src/Page.tsx': 'export const Page = 2;\n', 'e2e/page.spec.ts': '// focus\n', ...extra },
    WORK,
  );
  createGroup(work, 'page');
  const page = upsertCase(work, 'page', { title: 'Фокус', codePaths: ['src/Page.tsx'] }, WORK).id;
  const other = upsertCase(
    work,
    'page',
    { title: 'Документация', codePaths: ['docs/users.mdx'] },
    WORK,
  ).id;
  return { work, page, other };
}

function recordRun(
  work: string,
  id: string,
  startedAt: string,
  results: [string, ProjectTestStatus, string?][],
): void {
  const commitSha = git(work, ['rev-parse', '--short', 'HEAD']).trim();
  writeRun(work, {
    id,
    mode: 'run',
    actor: 'agent',
    commit: commitSha,
    status: 'done',
    startedAt,
    finishedAt: startedAt,
    results: results.map(([caseId, status, note]) => ({
      pointId: `page:${caseId}`,
      groupId: 'page',
      caseId,
      status,
      ...(note ? { note } : {}),
    })),
    summary: {
      total: results.length,
      passed: results.filter(([, status]) => status === 'passed').length,
      failed: results.filter(([, status]) => status === 'failed').length,
      skipped: 0,
      blocked: 0,
    },
  } as Parameters<typeof writeRun>[1]);
}

const row = (id: string, status: SieveStatus, evidence: string): SieveReportRow => ({
  id,
  status,
  evidence,
  at: REPORTED,
});

const BASE_ROWS = [
  row('boundary-negative', 'n/a', 'n/a: no input changed, only a constant'),
  row('tests-alongside', 'pass', 'e2e/page.spec.ts covers it'),
];

const gapsOf = (work: string, rows: SieveReportRow[]) =>
  sieveDeliveryGaps({ cwd: work, startedAt: STARTED, rows: [...BASE_ROWS, ...rows] });

describe('живое сито «не проверено» — заметка, а не пробел', () => {
  it('browser-focus fail «not checked: <причина>» — пробела нет, заметка с причиной, id для описания MR', async () => {
    const { work } = uiBranch();
    const gaps = await gapsOf(work, [
      row('browser-focus', 'fail', 'not checked: no browser can start on this machine'),
    ]);
    expect(gaps.missing.filter((line) => line.includes('browser-focus'))).toEqual([]);
    expect(gaps.notes).toEqual([
      expect.stringContaining('сито browser-focus: не проверено: no browser can start'),
    ]);
    expect(gaps.noted).toContain('browser-focus');
  });

  it('то же, но n/a на диффе с поведением — тоже заметка, а не «нельзя n/a»', async () => {
    const { work } = uiBranch();
    const gaps = await gapsOf(work, [
      row('browser-focus', 'n/a', 'не проверено: стенд ветки не поднимается без бэкенда'),
    ]);
    expect(gaps.missing.filter((line) => line.includes('browser-focus'))).toEqual([]);
    expect(gaps.noted).toContain('browser-focus');
  });

  it('fail без метки — пробел, как раньше', async () => {
    const { work } = uiBranch();
    const gaps = await gapsOf(work, [
      row('browser-focus', 'fail', 'не пройдено: нет бэкенда ветки на стенде'),
    ]);
    expect(gaps.missing.join('\n')).toContain('сито browser-focus не пройдено');
    expect(gaps.notes).toBeUndefined();
  });

  it('метка «не проверено» у НЕживого сита (проверки проекта) пробел не снимает', async () => {
    const { work } = uiBranch();
    const gaps = await gapsOf(work, [
      row('browser-focus', 'fail', 'not checked: no browser can start on this machine'),
      row('project-checks', 'fail', 'not checked: no time to run the gate'),
    ]);
    expect(gaps.missing.join('\n')).toContain('сито project-checks не пройдено');
    expect(gaps.noted).not.toContain('project-checks');
  });

  it('задание звена называет обе метки', async () => {
    const { work } = uiBranch();
    const prompt = await sievePrompt({ cwd: work, stage: 'deliver', done: [] });
    expect(prompt).toContain(NOTE_MARKS_LINE);
  });
});

describe('красное не из-за ветки в прогоне-доказательстве', () => {
  it('прогон красный на чужом кейсе, красном и до старта группы, — сито снято, заметка о прогоне', async () => {
    const { work, page, other } = uiBranch();
    recordRun(work, 'run-base-01', BASELINE, [[other, 'failed']]);
    recordRun(work, 'run-own-001', REPORTED, [
      [page, 'passed'],
      [other, 'failed'],
    ]);
    const gaps = await gapsOf(work, [
      row('browser-focus', 'pass', 'playwright focus → passed, run:run-own-001'),
    ]);
    expect(gaps.missing.filter((line) => line.includes('browser-focus'))).toEqual([]);
    expect(gaps.notes).toEqual([expect.stringContaining('прогон run-own-001')]);
    expect(gaps.noted).toEqual([other]);
  });

  it('чужой кейс упал по таймауту — окружение, сито снято', async () => {
    const { work, page, other } = uiBranch();
    recordRun(work, 'run-own-002', REPORTED, [
      [page, 'passed'],
      [other, 'failed', 'Timeout 30000ms exceeded'],
    ]);
    const gaps = await gapsOf(work, [
      row('browser-focus', 'pass', 'playwright focus → passed, run:run-own-002'),
    ]);
    expect(gaps.missing.filter((line) => line.includes('browser-focus'))).toEqual([]);
    expect(gaps.noted).toEqual([other]);
  });

  it('красный кейс, задетый диффом, держит — даже красный до старта и по таймауту', async () => {
    const { work, page } = uiBranch();
    recordRun(work, 'run-base-02', BASELINE, [[page, 'failed']]);
    recordRun(work, 'run-own-003', REPORTED, [[page, 'failed', 'Timeout 30000ms exceeded']]);
    const gaps = await gapsOf(work, [
      row('browser-focus', 'pass', 'playwright focus → passed, run:run-own-003'),
    ]);
    expect(gaps.missing.join('\n')).toContain(`в прогоне run-own-003 красные кейсы: ${page}`);
    expect(gaps.notes).toBeUndefined();
  });

  it('fail «not caused by the branch» со ссылкой на прогон, где красное задето веткой, — держит', async () => {
    const { work, page } = uiBranch();
    recordRun(work, 'run-own-004', REPORTED, [[page, 'failed']]);
    const gaps = await gapsOf(work, [
      row('browser-focus', 'fail', 'not caused by the branch: flaky on main, run:run-own-004'),
    ]);
    expect(gaps.missing.join('\n')).toContain('сито browser-focus не пройдено');
  });

  it('fail «not caused by the branch» без задетого красного — заметка', async () => {
    const { work, page, other } = uiBranch();
    recordRun(work, 'run-base-03', BASELINE, [[other, 'failed']]);
    recordRun(work, 'run-own-005', REPORTED, [
      [page, 'passed'],
      [other, 'failed'],
    ]);
    const gaps = await gapsOf(work, [
      row(
        'browser-focus',
        'fail',
        'not caused by the branch: the docs case is red on main too, run:run-own-005',
      ),
    ]);
    expect(gaps.missing.filter((line) => line.includes('browser-focus'))).toEqual([]);
    expect(gaps.notes?.join('\n')).toContain('сито browser-focus: красное не из-за ветки');
  });
});

describe('«не из-за ветки» у сита безопасности и данных — только со ссылкой на прогон', () => {
  // migration-safety — единственное сито класса data/security, чью строку сдаёт
  // группа (secrets — механика панели, строка `fail` пробела не даёт и так).
  const dataBranch = () =>
    uiBranch({ 'migrations/002_add_col.sql': 'ALTER TABLE users ADD COLUMN nick text;\n' });
  const ofSieve = (lines: string[], id: string) => lines.filter((line) => line.includes(id));

  it('migration-safety fail «not caused by the branch» словами, без прогона и команды, — держит', async () => {
    const { work } = dataBranch();
    const gaps = await gapsOf(work, [
      row('migration-safety', 'fail', 'not caused by the branch: the rollback was broken on main'),
    ]);
    expect(gaps.missing.join('\n')).toContain('сито migration-safety не пройдено');
    expect(gaps.noted ?? []).not.toContain('migration-safety');
  });

  it('migration-safety fail со ссылкой на прогон, где красное не задето веткой, — заметка', async () => {
    const { work, page, other } = dataBranch();
    recordRun(work, 'run-base-dat', BASELINE, [[other, 'failed']]);
    recordRun(work, 'run-own-dat1', REPORTED, [
      [page, 'passed'],
      [other, 'failed'],
    ]);
    const gaps = await gapsOf(work, [
      row(
        'migration-safety',
        'fail',
        'not caused by the branch: red on main too, run:run-own-dat1',
      ),
    ]);
    expect(ofSieve(gaps.missing, 'migration-safety')).toEqual([]);
    expect(gaps.noted).toContain('migration-safety');
  });

  it('migration-safety fail с командой и строкой её вывода на основной — заметка', async () => {
    const { work } = dataBranch();
    const gaps = await gapsOf(work, [
      row(
        'migration-safety',
        'fail',
        'not caused by the branch: on main `pnpm db:rollback` → `error: 001_init has no down step`',
      ),
    ]);
    expect(ofSieve(gaps.missing, 'migration-safety')).toEqual([]);
    expect(gaps.noted).toContain('migration-safety');
  });

  // RF-EF-02: ссылка проверялась только на «есть прогон», и любой id снимал
  // сито данных — даже зелёного прогона.
  it('migration-safety fail со ссылкой на зелёный прогон — держит', async () => {
    const { work, page } = dataBranch();
    recordRun(work, 'run-green-01', REPORTED, [[page, 'passed']]);
    const gaps = await gapsOf(work, [
      row('migration-safety', 'fail', 'not caused by the branch: fine, see run:run-green-01'),
    ]);
    expect(gaps.missing.join('\n')).toContain('сито migration-safety не пройдено');
    expect(gaps.noted ?? []).not.toContain('migration-safety');
  });

  it('migration-safety fail со ссылкой на прогон, красный только по таймауту, — держит: основной он не касается', async () => {
    const { work, page, other } = dataBranch();
    recordRun(work, 'run-own-dat2', REPORTED, [
      [page, 'passed'],
      [other, 'failed', 'Timeout 30000ms exceeded'],
    ]);
    const gaps = await gapsOf(work, [
      row('migration-safety', 'fail', 'not caused by the branch: red on main, run:run-own-dat2'),
    ]);
    expect(gaps.missing.join('\n')).toContain('сито migration-safety не пройдено');
  });

  it('migration-safety fail со ссылкой на прогон основной до старта группы — заметка', async () => {
    const { work, other } = dataBranch();
    recordRun(work, 'run-base-dat3', BASELINE, [[other, 'failed']]);
    const gaps = await gapsOf(work, [
      row('migration-safety', 'fail', 'not caused by the branch: red on main, run:run-base-dat3'),
    ]);
    expect(ofSieve(gaps.missing, 'migration-safety')).toEqual([]);
    expect(gaps.noted).toContain('migration-safety');
  });

  it('сито другого класса со ссылкой на зелёный прогон — держит: ссылка противоречит доводу', async () => {
    const { work, page } = uiBranch();
    recordRun(work, 'run-green-02', REPORTED, [[page, 'passed']]);
    const gaps = await gapsOf(work, [
      row('browser-focus', 'fail', 'not caused by the branch: flaky on main, run:run-green-02'),
    ]);
    expect(gaps.missing.join('\n')).toContain('сито browser-focus не пройдено');
  });

  // RF-EF-02: прогон, на который сослалась и строка-доказательство другого сита,
  // раньше в судью ссылок не шёл — зелёный «run:» снимал fail «не из-за ветки».
  it('ссылка на зелёный прогон-доказательство другого сита — тоже держит', async () => {
    const { work, page } = uiBranch();
    recordRun(work, 'run-green-03', REPORTED, [[page, 'passed']]);
    const gaps = await gapsOf(work, [
      row('contract-by-request', 'pass', 'request body checked, run:run-green-03'),
      row('browser-focus', 'fail', 'not caused by the branch: flaky on main, run:run-green-03'),
    ]);
    expect(gaps.missing.join('\n')).toContain('сито browser-focus не пройдено');
    expect(gaps.noted ?? []).not.toContain('browser-focus');
  });

  it('сито другого класса (browser-focus) — словами, как раньше, заметка', async () => {
    const { work } = uiBranch();
    const gaps = await gapsOf(work, [
      row('browser-focus', 'fail', 'not caused by the branch: the focus trap is broken on main'),
    ]);
    expect(ofSieve(gaps.missing, 'browser-focus')).toEqual([]);
    expect(gaps.noted).toContain('browser-focus');
  });
});
