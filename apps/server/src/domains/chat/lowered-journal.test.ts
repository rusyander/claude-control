import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoweredRunRecord } from '@agentdeck/contracts/model-cascade';
import {
  appendLoweredRun,
  journalPath,
  looksLikeCheck,
  readLoweredRuns,
  summarizeLoweredRuns,
} from './lowered-journal.ts';

/**
 * Журнал понижённых прогонов. Проверяется ровно то, ради чего он появился:
 * отметка `lowered` перестаёт умирать в маршруте, а «панель видела проверки»
 * отличается от «панель их не видела» — и второе не выдаётся за «агент не
 * проверял».
 */

const record = (patch: Partial<LoweredRunRecord> = {}): LoweredRunRecord => ({
  chatId: 'c1',
  model: 'claude-sonnet-5',
  effort: 'high',
  startedAt: 1_000,
  finishedAt: 2_000,
  ok: true,
  checks: [],
  ...patch,
});

describe('looksLikeCheck', () => {
  it('узнаёт прогон проверок в обычных для проектов формах', () => {
    const commands = [
      'pnpm test',
      'npm run lint',
      'yarn type-check',
      'bun run tests',
      'npx vitest run src/x.test.ts',
      'npx tsc --noEmit',
      'eslint . --fix',
      'go test ./...',
      'cargo test',
      'make check',
      'pytest -q',
      'ruff check .',
    ];
    for (const command of commands) {
      expect(looksLikeCheck(command), command).toBe(true);
    }
  });

  it('не считает проверкой слово test в чужом контексте', () => {
    const commands = [
      'git commit -m "fix tests"',
      'ls src/__tests__',
      'cat package.json',
      'rm -rf test-output',
      'echo latest',
      'git log --grep=test',
    ];
    for (const command of commands) {
      expect(looksLikeCheck(command), command).toBe(false);
    }
  });

  it('регистр значения не имеет', () => {
    expect(looksLikeCheck('PNPM TEST')).toBe(true);
  });
});

describe('журнал на диске', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'journal-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('пустой каталог читается пустым журналом, а не падением', () => {
    expect(readLoweredRuns(dir)).toEqual([]);
  });

  it('дописывает записи и возвращает их в порядке записи', () => {
    appendLoweredRun(dir, record({ chatId: 'a' }));
    appendLoweredRun(dir, record({ chatId: 'b' }));

    expect(readLoweredRuns(dir).map((entry) => entry.chatId)).toEqual(['a', 'b']);
  });

  it('держит предел: старые записи вытесняются свежими', () => {
    for (let i = 0; i < 205; i += 1) appendLoweredRun(dir, record({ chatId: `c${i}` }));

    const runs = readLoweredRuns(dir);
    expect(runs).toHaveLength(200);
    expect(runs[0]?.chatId).toBe('c5');
    expect(runs.at(-1)?.chatId).toBe('c204');
  });

  it('битый файл — пустой журнал, а не исключение', () => {
    writeFileSync(journalPath(dir), '{ это не json', 'utf8');
    expect(readLoweredRuns(dir)).toEqual([]);
  });

  it('чужие записи в файле отбрасываются по форме', () => {
    writeFileSync(journalPath(dir), JSON.stringify([{ nonsense: true }, record()]), 'utf8');
    expect(readLoweredRuns(dir)).toHaveLength(1);
  });

  it('пишет именно в lowered-runs.json', () => {
    appendLoweredRun(dir, record());
    expect(JSON.parse(readFileSync(join(dir, 'lowered-runs.json'), 'utf8'))).toHaveLength(1);
  });
});

describe('summarizeLoweredRuns', () => {
  it('считает прогоны без замеченных проверок и упавшие', () => {
    const summary = summarizeLoweredRuns([
      record({ checks: ['pnpm test'] }),
      record({ checks: [] }),
      record({ checks: [], ok: false }),
    ]);

    expect(summary).toEqual({ total: 3, withChecks: 1, withoutChecks: 1, failed: 1 });
  });

  it('упавший прогон не записывается в «сдал без проверок»', () => {
    // Прогон, который не дошёл до конца, проверок и не мог запустить: место ему
    // только в `failed`, иначе сводка обвиняет агента чужой виной.
    const summary = summarizeLoweredRuns([
      record({ checks: [], ok: false }),
      record({ checks: ['pnpm lint'], ok: false }),
    ]);

    expect(summary).toEqual({ total: 2, withChecks: 0, withoutChecks: 0, failed: 2 });
  });

  it('три корзины не пересекаются и в сумме дают общее число', () => {
    const summary = summarizeLoweredRuns([
      record({ checks: ['pnpm test'] }),
      record({ checks: [] }),
      record({ checks: [], ok: false }),
      record({ checks: ['pnpm lint'] }),
    ]);

    expect(summary.withChecks + summary.withoutChecks + summary.failed).toBe(summary.total);
  });

  it('пустой журнал не даёт делений на ноль и нулей-обманок', () => {
    expect(summarizeLoweredRuns([])).toEqual({
      total: 0,
      withChecks: 0,
      withoutChecks: 0,
      failed: 0,
    });
  });
});
