import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SieveReportRow } from '@agentdeck/contracts/sieves';
import { createGroup, upsertCase, writeRun } from '../../project-tests/project-tests.ts';
import { sieveDeliveryGaps, sievePrompt } from './sieve-gate.ts';

/**
 * Проверка доставки целиком, на НАСТОЯЩЕМ git и настоящей истории блока
 * «Тесты»: механика панели находит то, что доезжает до prod мимо ревью, строка
 * отчёта, сданная до правки, не в счёт, а живую проверку доказывает только
 * прогон, который панель сама открыла в истории копии.
 */

const SEED = '2026-01-01T10:00:00Z';
const STARTED = '2026-02-01T10:00:00Z';
const WORK = '2026-02-02T10:00:00Z';
const REPORTED = '2026-02-03T10:00:00.000Z';
const LATER = '2026-02-04T10:00:00Z';

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

/** Удалённый с основной и копия группы на ветке `grp`. */
function copy(seed: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sieve-gate-'));
  dirs.push(root);
  const origin = join(root, 'origin.git');
  const main = join(root, 'main');
  const work = join(root, 'work');
  git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(root, ['clone', '-q', origin, main]);
  git(main, ['checkout', '-q', '-b', 'main']);
  commit(main, seed, SEED);
  git(main, ['push', '-q', '-u', 'origin', 'main']);
  git(root, ['clone', '-q', origin, work]);
  git(work, ['checkout', '-q', '-b', 'grp']);
  return work;
}

/**
 * Поддельный ключ собирается из частей: литерал формы вендора в исходнике —
 * ровно то, что ловит сито «секреты» (и сканер секретов форджа), даже в тесте.
 */
const FAKE_KEY = ['sk', 'live', 'FAKEfakeFAKEfake0000'].join('_');

const row = (id: string, evidence: string): SieveReportRow => ({
  id,
  status: 'pass',
  evidence,
  at: REPORTED,
});

describe('доставка: механика панели на настоящей ветке', () => {
  it('ключ, новая переменная, .only, .env и зависимость без лока — каждое пробелом', async () => {
    const work = copy({
      'package.json': '{\n  "dependencies": {\n    "zod": "^3.0.0"\n  }\n}\n',
      'package-lock.json': '{}\n',
      'src/pay.ts': 'export const pay = 1;\n',
      'src/pay.test.ts': "it('pays', () => {});\n",
    });
    commit(
      work,
      {
        'package.json':
          '{\n  "dependencies": {\n    "zod": "^3.0.0",\n    "stripe": "^14.0.0"\n  }\n}\n',
        'src/pay.ts': `export const pay = 1;\nconst key = '${FAKE_KEY}';\nconst url = process.env.PAYMENTS_URL;\n`,
        'src/pay.test.ts': "it.only('pays', () => {});\n",
        '.env.local': 'PAYMENTS_URL=http://localhost\n',
      },
      WORK,
    );
    const gaps = await sieveDeliveryGaps({ cwd: work, startedAt: STARTED, rows: [] });
    const text = gaps.missing.join('\n');
    expect(text).toContain('сито «секреты»');
    expect(text).toContain('src/pay.ts');
    expect(text).toContain('PAYMENTS_URL');
    expect(text).toContain('сито «остатки отладки»');
    expect(text).toContain('сито «лишнее в git»: добавлены файлы');
    expect(text).toContain('.env.local');
    expect(text).toContain('сито «lockfile»');
    expect(gaps.classes).toEqual(expect.arrayContaining(['security', 'hygiene', 'integration']));
  });

  it('объявленная в .env.example переменная — не пробел', async () => {
    const work = copy({
      '.env.example': 'PAYMENTS_URL=\n',
      'src/pay.ts': 'export const pay = 1;\n',
      'src/pay.test.ts': "it('pays', () => {});\n",
    });
    commit(
      work,
      {
        'src/pay.ts': 'export const pay = 1;\nconst url = process.env.PAYMENTS_URL;\n',
        'src/pay.test.ts': "it('pays with url', () => {});\n",
      },
      WORK,
    );
    const gaps = await sieveDeliveryGaps({ cwd: work, startedAt: STARTED, rows: [] });
    expect(gaps.missing.join('\n')).not.toContain('PAYMENTS_URL');
  });
});

describe('доставка: свежесть отчёта и прогоны блока «Тесты»', () => {
  let caseId = '';

  /** Ветка с правкой интерфейса и тестом; блок «Тесты» с одним кейсом. */
  function uiBranch(): string {
    const work = copy({ 'src/Page.tsx': 'export const Page = 1;\n', 'e2e/page.spec.ts': '//\n' });
    commit(
      work,
      { 'src/Page.tsx': 'export const Page = 2;\n', 'e2e/page.spec.ts': '// focus\n' },
      WORK,
    );
    createGroup(work, 'page');
    caseId = upsertCase(work, 'page', { title: 'Фокус' }, WORK).id;
    return work;
  }

  const focusGaps = async (work: string, evidence: string) =>
    (
      await sieveDeliveryGaps({
        cwd: work,
        startedAt: STARTED,
        rows: [
          row('browser-focus', evidence),
          row('boundary-negative', 'n/a: no input changed, only a constant'),
          row('tests-alongside', 'e2e/page.spec.ts covers it'),
        ],
      })
    ).missing.filter((line) => line.includes('browser-focus'));

  function recordRun(work: string, id: string, status: 'passed' | 'failed' | 'skipped'): void {
    const commitSha = git(work, ['rev-parse', '--short', 'HEAD']).trim();
    writeRun(work, {
      id,
      mode: 'run',
      actor: 'agent',
      commit: commitSha,
      status: 'done',
      startedAt: REPORTED,
      finishedAt: REPORTED,
      results: [{ pointId: `page:${caseId}`, groupId: 'page', caseId, status }],
      summary: {
        total: 1,
        passed: status === 'passed' ? 1 : 0,
        failed: status === 'failed' ? 1 : 0,
        skipped: status === 'skipped' ? 1 : 0,
        blocked: 0,
      },
    } as Parameters<typeof writeRun>[1]);
  }

  it('блок есть, а доказательство — слова: нужен run:<id>', async () => {
    const work = uiBranch();
    const gaps = await focusGaps(work, 'npx playwright test focus → 3 passed');
    expect(gaps.join('\n')).toContain('run:<id>');
  });

  it('записанный зелёный прогон на этом коммите — снимает', async () => {
    const work = uiBranch();
    recordRun(work, 'run-green-1', 'passed');
    expect(await focusGaps(work, 'playwright focus → passed, run:run-green-1')).toEqual([]);
  });

  it('красный прогон и выдуманный номер — пробел', async () => {
    const work = uiBranch();
    recordRun(work, 'run-red-01', 'failed');
    expect((await focusGaps(work, 'focus run:run-red-01')).join('\n')).toContain(caseId);
    expect((await focusGaps(work, 'focus run:run-made-up')).join('\n')).toContain('нет в истории');
  });

  // Ревью PR #1: прогон, где всё пропущено, ничего не проверил — не доказательство.
  it('прогон из одних пропусков — пробел, а не доказательство', async () => {
    const work = uiBranch();
    recordRun(work, 'run-skip-1', 'skipped');
    expect((await focusGaps(work, 'focus run:run-skip-1')).join('\n')).toContain(
      'ничего не проверил',
    );
  });

  it('после прогона и отчёта интерфейс правили — и строка, и прогон устарели', async () => {
    const work = uiBranch();
    recordRun(work, 'run-green-2', 'passed');
    commit(work, { 'src/Page.tsx': 'export const Page = 3;\n' }, LATER);
    const gaps = (await focusGaps(work, 'focus → passed run:run-green-2')).join('\n');
    expect(gaps).toContain('после сдачи строки ветка меняла');
    expect(gaps).toContain('src/Page.tsx');
  });

  it('задание звена: устаревшее сито — снова в работе, блок «Тесты» просит run:<id>', async () => {
    const work = uiBranch();
    commit(work, { 'src/Page.tsx': 'export const Page = 4;\n' }, LATER);
    const prompt = await sievePrompt({
      cwd: work,
      stage: 'deliver',
      done: [row('browser-focus', 'npx playwright test focus → 3 passed')],
    });
    expect(prompt).toContain('[browser-focus] (again');
    expect(prompt).toContain('run:<id>');
  });
});
