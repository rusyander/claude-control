import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adoptableEntries,
  isPidAlive,
  ledgerPath,
  MAX_AGE_MS,
  pickCliChild,
  readRunLedger,
  resolveCliPid,
  RunLedger,
  type RunLedgerEntry,
} from './run-ledger.ts';

/**
 * Журнал идущих прогонов на диске: то, по чему после перезапуска панели живые
 * процессы CLI усыновляются, а не встречают пустой реестр. Здесь — сам файл
 * (запись, замена, предел, порча) и отбор записей на усыновление.
 */
const entry = (key: string, extra: Partial<RunLedgerEntry> = {}): RunLedgerEntry => ({
  key,
  cwd: '/proj',
  startedAt: 1_000,
  ...extra,
});

describe('RunLedger — журнал идущих прогонов', () => {
  let dir: string;
  let ledger: RunLedger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-ledger-'));
    ledger = new RunLedger(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('пустой каталог — пустой журнал, файл не создаётся', () => {
    expect(ledger.read()).toEqual([]);
    expect(existsSync(ledgerPath(dir))).toBe(false);
  });

  it('upsert пишет запись, повтор по ключу заменяет её, а не дублирует', () => {
    ledger.upsert(entry('a', { pid: 10 }));
    ledger.upsert(entry('b', { pid: 11 }));
    ledger.upsert(entry('a', { pid: 10, sessionId: 'sess-a' }));

    const keys = ledger.read().map((item) => [item.key, item.sessionId]);
    expect(keys).toEqual([
      ['b', undefined],
      ['a', 'sess-a'],
    ]);
  });

  it('remove убирает запись; чужой ключ ничего не меняет', () => {
    ledger.upsert(entry('a'));
    ledger.remove('ghost');
    expect(ledger.read().map((item) => item.key)).toEqual(['a']);
    ledger.remove('a');
    expect(ledger.read()).toEqual([]);
  });

  it('битый файл читается как пустой журнал, без исключения', () => {
    writeFileSync(ledgerPath(dir), '{not json', 'utf8');
    expect(readRunLedger(dir)).toEqual([]);
    // И писать поверх порчи можно.
    ledger.upsert(entry('a'));
    expect(ledger.read().map((item) => item.key)).toEqual(['a']);
  });

  it('записи без ключа, каталога или времени старта отбрасываются', () => {
    writeFileSync(
      ledgerPath(dir),
      JSON.stringify([{ key: 'a' }, { key: 'b', cwd: '/x', startedAt: 5 }, 'мусор', null]),
      'utf8',
    );
    expect(readRunLedger(dir).map((item) => item.key)).toEqual(['b']);
  });

  it('журнал не растёт бесконечно — старые записи вытесняются', () => {
    for (let index = 0; index < 110; index += 1) ledger.upsert(entry(`k-${index}`));
    const kept = ledger.read();
    expect(kept).toHaveLength(100);
    expect(kept[0]?.key).toBe('k-10');
    expect(kept.at(-1)?.key).toBe('k-109');
  });
});

describe('isPidAlive', () => {
  it('свой процесс жив', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('невозможный pid мёртв', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
    // Больше pid_max Linux и нечётный для Windows — такого процесса нет нигде.
    expect(isPidAlive(2 ** 22 + 1)).toBe(false);
  });
});

describe('adoptableEntries — кого усыновлять после перезапуска', () => {
  const now = 10_000_000;
  const probe = (alive: number[], cli: number[] = alive) => ({
    isAlive: (pid: number) => alive.includes(pid),
    looksLikeCli: (pid: number) => cli.includes(pid),
  });

  it('живой, свежий и похожий на CLI — усыновляем; остальных вычищаем', () => {
    const entries = [
      entry('live', { pid: 10, startedAt: now - 1_000 }),
      entry('dead', { pid: 11, startedAt: now - 1_000 }),
      entry('no-pid', { startedAt: now - 1_000 }),
      entry('old', { pid: 12, startedAt: now - MAX_AGE_MS - 1 }),
      entry('foreign', { pid: 13, startedAt: now - 1_000 }),
    ];
    const { adopt, drop } = adoptableEntries(entries, probe([10, 12, 13], [10, 12]), now);
    expect(adopt.map((item) => item.key)).toEqual(['live']);
    expect(drop.map((item) => item.key)).toEqual(['dead', 'no-pid', 'old', 'foreign']);
  });

  it('устаревшую запись не спрашивают у системы вовсе', () => {
    const asked: number[] = [];
    const { adopt } = adoptableEntries(
      [entry('old', { pid: 12, startedAt: now - MAX_AGE_MS - 1 })],
      {
        isAlive: (pid) => {
          asked.push(pid);
          return true;
        },
        looksLikeCli: () => true,
      },
      now,
    );
    expect(adopt).toEqual([]);
    expect(asked).toEqual([]);
  });
});

describe('resolveCliPid — в журнал идёт сам CLI, а не оболочка', () => {
  it('среди детей обёртки выбирается claude/node, conhost и cmd пропускаются', () => {
    expect(
      pickCliChild([
        { pid: 11, name: 'conhost.exe' },
        { pid: 12, name: 'cmd.exe' },
        { pid: 13, name: 'claude.exe' },
      ]),
    ).toBe(13);
    expect(pickCliChild([{ pid: 21, name: 'node.exe' }])).toBe(21);
    expect(pickCliChild([{ pid: 31, name: 'conhost.exe' }])).toBeUndefined();
  });

  it('CLI появляется под обёрткой не сразу — повторяет запрос, потом сдаётся на обёртку', async () => {
    const answers: { pid: number; name: string }[][] = [[], [{ pid: 5, name: 'claude.exe' }]];
    const asked: number[] = [];
    const list = async (pid: number) => {
      asked.push(pid);
      return answers.shift() ?? [];
    };
    expect(await resolveCliPid(100, { list, delayMs: 0 })).toBe(5);
    expect(asked).toEqual([100, 100]);

    expect(await resolveCliPid(200, { list: async () => [], attempts: 2, delayMs: 0 })).toBe(200);
  });
});
