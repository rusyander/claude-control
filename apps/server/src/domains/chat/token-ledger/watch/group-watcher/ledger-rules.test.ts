import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commandCheck } from './ledger-checks.ts';
import { createLedgerFeed } from './ledger-feed.ts';
import {
  emptyCopyLedger,
  foldLedger,
  ledgerFinding,
  ledgerGaps,
  repoOf,
  type CopyLedger,
  type LedgerFeedEvent,
  type LedgerSnapshot,
} from './ledger-rules.ts';

/**
 * Журнал проверок глазами сторожа групп (R40, R41) на вырезках, собранных по строкам
 * журнала живого прогона: каждая — пара «срабатывание / близкий промах».
 */

const MIN = 60_000;
const APP = 'C:\\work\\app';
const T = (hms: string): number => Date.parse(`2026-10-26T${hms}Z`);

function fixture(name: string): LedgerFeedEvent[] {
  return readFileSync(new URL(`../__fixtures__/leak/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerFeedEvent);
}

function snapshotOf(events: readonly LedgerFeedEvent[]): LedgerSnapshot {
  const copies = new Map<string, CopyLedger>();
  for (const event of events) {
    const repo = repoOf(event)!;
    const copy = copies.get(repo) ?? emptyCopyLedger();
    copies.set(repo, copy);
    foldLedger(copy, event);
  }
  return {
    ...(events.length > 0 ? { since: Math.min(...events.map((e) => e.at)) } : {}),
    copies,
    recent: events.map((e) => ({ at: e.at, repo: e.repo! })),
  };
}

describe('R40 журнал проверок в копии работает не так, как обещает', () => {
  it('вырезка срабатывания: повтор пропущен, журнал выключен, повтор солгал бы, режим без повторов — по одной находке каждого рода', () => {
    const snap = snapshotOf(fixture('R40-ledger/fire.jsonl'));
    const copy = snap.copies.get('c:/work/app')!;
    expect(copy.findings.map((f) => f.kind)).toEqual(['replay', 'off', 'mismatch', 'mode']);
    expect(copy.findings[0]).toMatchObject({ check: 'vitest', key: 'k1', at: T('09:20:05') });
    expect(copy.findings[1]).toMatchObject({ reason: 'registry unreadable' });
    expect(copy.findings[3]).toMatchObject({ mode: 'shadow' });
    const hit = ledgerFinding(snap, APP, T('09:25:00'));
    expect(hit).toMatchObject({
      rule: 'R40',
      severity: 'info',
      numbers: { findings: 4 },
      params: { check: 'vitest', mode: 'shadow' },
      since: T('09:20:05'),
      textKey: 'groupWatch.rule.R40mode',
    });
  });

  it('несовпадение повтора: выходы оба известны — строка с выходами, без них — без подстановок', () => {
    const at = T('09:00:00');
    const copy = emptyCopyLedger();
    foldLedger(copy, {
      at,
      kind: 'mismatch',
      check: 'tsc',
      repo: APP,
      key: 'k',
      exit: 2,
      recordedExit: 0,
    });
    const snap = { since: at, copies: new Map([['c:/work/app', copy]]), recent: [] };
    expect(ledgerFinding(snap, APP, at + MIN)).toMatchObject({
      numbers: { findings: 1, exit: 2, recordedExit: 0 },
      textKey: 'groupWatch.rule.R40mismatchExit',
    });
    const bare = emptyCopyLedger();
    foldLedger(bare, { at, kind: 'mismatch', check: 'tsc', repo: APP, key: 'k' });
    const hit = ledgerFinding(
      { since: at, copies: new Map([['c:/work/app', bare]]), recent: [] },
      APP,
      at + MIN,
    );
    expect(hit?.textKey).toBe('groupWatch.rule.R40mismatch');
    expect(hit?.numbers).toEqual({ findings: 1 });
  });

  it('вырезка близкого промаха: первый взгляд на ключ, красная запись, промах «stale», дерево сменилось, повтор — молчит', () => {
    const snap = snapshotOf(fixture('R40-ledger/near-miss.jsonl'));
    expect(snap.copies.get('c:/work/app')!.findings).toEqual([]);
    expect(ledgerFinding(snap, APP, T('09:15:00'))).toBeUndefined();
  });

  it('находка держится полчаса; копия другой группы и каталог без журнала — молчат', () => {
    const snap = snapshotOf(fixture('R40-ledger/fire.jsonl'));
    expect(ledgerFinding(snap, APP, T('09:23:00') + 30 * MIN)).toBeDefined();
    expect(ledgerFinding(snap, APP, T('09:23:00') + 31 * MIN)).toBeUndefined();
    expect(ledgerFinding(snap, 'C:\\work\\other', T('09:25:00'))).toBeUndefined();
    expect(ledgerFinding(snap, 'C:\\work\\ap', T('09:25:00'))).toBeUndefined();
    expect(ledgerFinding(undefined, APP, T('09:25:00'))).toBeUndefined();
    // Репозиторий внутри копии (монорепо, вложенный пакет) — тоже копия группы.
    expect(ledgerFinding(snap, 'C:/work', T('09:25:00'))).toBeDefined();
  });

  it('одна находка рода и ключа поднимается один раз: второй «off» той же причины — не новая', () => {
    const copy = emptyCopyLedger();
    for (const at of [T('09:00:00'), T('09:05:00')]) {
      foldLedger(copy, { at, kind: 'off', check: 'vitest', repo: APP, reason: 'no git' });
    }
    expect(copy.findings).toHaveLength(1);
  });
});

const RUN = {
  start: T('10:00:00'),
  end: T('10:00:40'),
  check: 'vitest',
  command: 'npx vitest run src/app.test.ts',
};

describe('R41 проверка группы прошла мимо журнала (GAP)', () => {
  it('вырезка срабатывания: журнал жив, а из копии за время прогона ни события — сведение через 20 с после конца', () => {
    const snap = snapshotOf(fixture('R41-gap/fire.jsonl'));
    expect(ledgerGaps(snap, APP, [RUN], RUN.end + 19_000)).toBeUndefined();
    expect(ledgerGaps(snap, APP, [RUN], RUN.end + 20_000)).toEqual({
      rule: 'R41',
      severity: 'info',
      numbers: { runs: 1, ranSec: 40 },
      params: { check: 'vitest', command: 'npx vitest run src/app.test.ts' },
      since: RUN.end,
    });
    // Полчаса после конца — уже не судим.
    expect(ledgerGaps(snap, APP, [RUN], RUN.end + 31 * MIN)).toBeUndefined();
  });

  it('вырезка близкого промаха: запись прогона легла через 2 с после конца — не GAP', () => {
    const snap = snapshotOf(fixture('R41-gap/near-miss.jsonl'));
    expect(ledgerGaps(snap, APP, [RUN], RUN.end + MIN)).toBeUndefined();
  });

  it('границы окна: событие за 3 с до начала и за 10 с после конца — своё, на шаг дальше — нет', () => {
    const run = { ...RUN };
    const at = (t: number) =>
      snapshotOf([
        { at: T('09:00:00'), kind: 'record', repo: APP },
        { at: t, kind: 'miss', repo: APP },
      ]);
    expect(ledgerGaps(at(run.start - 3_000), APP, [run], run.end + MIN)).toBeUndefined();
    expect(ledgerGaps(at(run.end + 10_000), APP, [run], run.end + MIN)).toBeUndefined();
    expect(ledgerGaps(at(run.start - 3_001), APP, [run], run.end + MIN)?.rule).toBe('R41');
    expect(ledgerGaps(at(run.end + 10_001), APP, [run], run.end + MIN)?.rule).toBe('R41');
  });

  it('прогон раньше первого события журнала (25.10: 13 ложных GAP) и панель без журнала — молчат', () => {
    const snap = snapshotOf(fixture('R41-gap/before-feed.jsonl'));
    expect(ledgerGaps(snap, APP, [RUN], RUN.end + MIN)).toBeUndefined();
    expect(
      ledgerGaps({ copies: new Map(), recent: [] }, APP, [RUN], RUN.end + MIN),
    ).toBeUndefined();
  });

  it('проверка запущена в чужом каталоге, и журнал видел её там — не GAP; каталог не назван — GAP', () => {
    const other = 'C:\\work\\x\\y\\other-repo';
    const events: LedgerFeedEvent[] = [
      { at: T('09:00:00'), kind: 'record', repo: APP },
      { at: T('10:00:30'), kind: 'record', repo: other },
    ];
    const named = { ...RUN, command: 'cd C:/WORK/x/y/other-repo && npx vitest run' };
    expect(ledgerGaps(snapshotOf(events), APP, [named], RUN.end + MIN)).toBeUndefined();
    expect(ledgerGaps(snapshotOf(events), APP, [RUN], RUN.end + MIN)?.rule).toBe('R41');
  });
});

describe('ledger-checks: что журнал обязан увидеть — его же распознавателем', () => {
  const scripts = (dir: string) =>
    dir === '/work/app'
      ? {
          test: 'vitest run --coverage.enabled=false',
          lint: 'eslint .',
          'type-check': 'tsc --noEmit',
          dev: 'vite',
          watch: 'vitest',
          all: 'pnpm test && pnpm lint',
        }
      : undefined;
  it.each([
    ['npx vitest run src/a.test.ts', 'vitest'],
    ['npx tsc --noEmit -p .', 'tsc'],
    ['pnpm test', 'vitest'],
    ['npm t', 'vitest'],
    ['pnpm run lint', 'eslint'],
    ['pnpm type-check', 'tsc'],
    ['npx prettier --check .', 'prettier'],
    ['node node_modules/vitest/vitest.mjs run', 'vitest'],
    ['CI=1 pnpm exec vitest run x', 'vitest'],
    ['git status && npx tsc --noEmit 2>&1 | tail -5', 'tsc'],
  ])('проверка: %s → %s', (command, check) => {
    expect(commandCheck(command, '/work/app', scripts)).toBe(check);
  });
  it.each([
    'pnpm dev',
    'pnpm watch',
    'npx vitest',
    'npx eslint --fix .',
    'npx prettier --write .',
    'npx tsc -p .',
    'pnpm --filter web test',
    'pnpm -r test',
    'pnpm all',
    'cd sub && pnpm test',
    'grep vitest a.txt',
    'node tools/qa/check-help.mjs',
  ])('не проверка журнала: %s', (command) => {
    expect(commandCheck(command, '/work/app', scripts)).toBeUndefined();
  });
});

describe('ledger-feed: хвост events.jsonl с места прошлого чтения', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('первое чтение, дописка, строка наполовину, смена файла — каждое событие свёрнуто один раз', () => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-feed-'));
    const file = join(dir, 'events.jsonl');
    const lines = readFileSync(
      new URL('../__fixtures__/leak/R40-ledger/fire.jsonl', import.meta.url),
      'utf8',
    ).split('\n');
    const now = T('09:30:00');
    const feed = createLedgerFeed(dir, () => now);
    // Журнала нет — пусто, `since` нет.
    expect(feed.read().since).toBeUndefined();
    writeFileSync(file, `${lines.slice(0, 2).join('\n')}\n`);
    expect(feed.read().copies.get('c:/work/app')?.ats).toHaveLength(2);
    // Дописка наполовину: строка без конца ждёт следующего чтения.
    const third = lines[2]!;
    appendFileSync(file, `${lines.slice(2, 4).join('\n')}\n${third.slice(0, 10)}`);
    const snap = feed.read();
    expect(snap.copies.get('c:/work/app')?.ats).toHaveLength(4);
    expect(snap.copies.get('c:/work/app')?.findings.map((f) => f.kind)).toEqual(['replay']);
    appendFileSync(file, `${third.slice(10)}\n`);
    expect(feed.read().copies.get('c:/work/app')?.ats).toHaveLength(5);
    // Файл ушёл в `.1`, новый короче прочитанного — читается с начала.
    renameSync(file, `${file}.1`);
    writeFileSync(file, `${lines[4]}\n`);
    const after = feed.read();
    expect(after.copies.get('c:/work/app')?.ats).toHaveLength(6);
    expect(after.copies.get('c:/work/app')?.findings.map((f) => f.kind)).toEqual(['replay', 'off']);
    expect(after.since).toBe(T('09:00:00'));
  });

  it('скрипты package.json: читаются и перечитываются при правке файла', () => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-scripts-'));
    const feed = createLedgerFeed(dir);
    expect(feed.scriptsOf(dir)).toBeUndefined();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    expect(feed.scriptsOf(dir)).toEqual({ test: 'vitest run' });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' } }),
    );
    expect(feed.scriptsOf(dir)).toEqual({ test: 'vitest run', lint: 'eslint .' });
  });
});
