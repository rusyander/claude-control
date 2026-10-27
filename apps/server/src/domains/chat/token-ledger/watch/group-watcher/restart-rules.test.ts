import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GROUP_WATCH_DEFAULTS } from '@agentdeck/contracts/group-watch';
import { DEV_RESTART_STATE, DEV_WATCH_LOG } from '../../../../../lib/dev-restart.mjs';
import { normPath } from '../reduce-util.ts';
import { createRestartFeed } from './dev-restarts.ts';
import {
  parseDevRestarts,
  restartByGroup,
  restartStorm,
  type RestartFeed,
} from './restart-rules.ts';

/**
 * Перезапуски сервера панели глазами сторожа групп: R38 — перезапуск ждёт правок группы,
 * R39 — перезапусков за час столько, что сам перезапуск и есть беда. Вырезки журнала
 * dev-watch — пары «срабатывание / близкий промах».
 */

const MIN = 60_000;
const T = (hms: string): number => Date.parse(`2026-10-26T${hms}Z`);
const ROOT = 'C:\\work\\panel';
const panel = (file: string) => `${ROOT}\\apps\\server\\src\\${file}`;
const fixture = (name: string) =>
  readFileSync(new URL(`../__fixtures__/leak/${name}`, import.meta.url), 'utf8');

describe('parseDevRestarts: строки «перезапуск: …» журнала dev-watch', () => {
  it('случившиеся перезапуски с файлами; «и ещё N» снят; отложенный и ненужный — не перезапуск', () => {
    expect(parseDevRestarts(fixture('R39-restart-storm/fire.log'))).toEqual([
      { at: T('11:05:00'), files: [panel('a.ts')] },
      { at: T('11:25:00'), files: [panel('a.ts'), panel('b.ts')] },
      { at: T('11:40:00'), files: [panel('c.ts')] },
    ]);
    expect(parseDevRestarts('мусор\n2026-xx перезапуск: a.ts\n')).toEqual([]);
  });

  it('строка отсрочки перед перезапуском — начало ожидания; «не нужен» её снимает', () => {
    expect(parseDevRestarts(fixture('R38-restart/done.log'))).toEqual([
      {
        at: T('12:10:00'),
        files: [panel('a.ts'), panel('b.ts'), panel('c.ts')],
        deferredAt: T('11:58:00'),
      },
      { at: T('12:25:00'), files: [panel('d.ts')] },
    ]);
  });
});

describe('R39 перезапусков за час — столько и больше', () => {
  it('вырезка срабатывания: три за час — сведение с третьего', () => {
    const done = parseDevRestarts(fixture('R39-restart-storm/fire.log'));
    expect(restartStorm({ done }, GROUP_WATCH_DEFAULTS, T('11:45:00'))).toEqual({
      rule: 'R39',
      severity: 'info',
      numbers: { restarts: 3 },
      since: T('11:40:00'),
    });
  });

  it('вырезка близкого промаха: третий был час и пять минут назад, отложенный и ненужный не в счёт', () => {
    const done = parseDevRestarts(fixture('R39-restart-storm/near-miss.log'));
    expect(done).toHaveLength(3);
    expect(restartStorm({ done }, GROUP_WATCH_DEFAULTS, T('11:45:00'))).toBeUndefined();
  });

  it('граница: ровно час назад — уже не в часе; порог из настроек', () => {
    const done = parseDevRestarts(fixture('R39-restart-storm/fire.log'));
    expect(restartStorm({ done }, GROUP_WATCH_DEFAULTS, T('12:05:00'))).toBeUndefined();
    expect(restartStorm({ done }, GROUP_WATCH_DEFAULTS, T('12:04:59'))?.numbers).toEqual({
      restarts: 3,
    });
    expect(
      restartStorm({ done }, { ...GROUP_WATCH_DEFAULTS, restartStorm: 4 }, T('11:45:00')),
    ).toBeUndefined();
    expect(restartStorm(undefined, GROUP_WATCH_DEFAULTS, T('11:45:00'))).toBeUndefined();
  });
});

describe('R38 перезапуск ждёт правок группы', () => {
  const pending: RestartFeed = {
    done: [],
    pending: { since: T('12:00:00'), files: [panel('a.ts'), panel('b.ts')] },
  };
  const edit = (hms: string, file: string) => ({ at: T(hms), path: normPath(file) });

  const now = T('12:05:00');

  it('правка файла, которого ждёт перезапуск, за десять минут до него — сведение и минуты ожидания', () => {
    expect(restartByGroup(pending, [edit('11:50:00', panel('a.ts'))], now)).toEqual({
      rule: 'R38',
      severity: 'info',
      textKey: 'groupWatch.rule.R38wait',
      numbers: { files: 1, waiting: 2, waitMin: 5 },
      params: { path: panel('a.ts') },
      since: T('11:50:00'),
    });
  });

  it('близкий промах: правка старше десяти минут, чужой файл, перезапуска не ждём', () => {
    expect(restartByGroup(pending, [edit('11:49:59', panel('a.ts'))], now)).toBeUndefined();
    expect(restartByGroup(pending, [edit('11:55:00', panel('z.ts'))], now)).toBeUndefined();
    expect(restartByGroup({ done: [] }, [edit('11:55:00', panel('a.ts'))], now)).toBeUndefined();
    expect(restartByGroup(undefined, [edit('11:55:00', panel('a.ts'))], now)).toBeUndefined();
  });
});

describe('R38done перезапуск из-за правок группы уже случился', () => {
  const feed: RestartFeed = { done: parseDevRestarts(fixture('R38-restart/done.log')) };
  const edit = (hms: string, file: string) => ({ at: T(hms), path: normPath(file) });
  const two = () => 2;

  it('правка за десять минут до начала ожидания — файлы, минуты ожидания, другие живые группы', () => {
    expect(restartByGroup(feed, [edit('11:48:00', panel('a.ts'))], T('12:30:00'), two)).toEqual({
      rule: 'R38',
      severity: 'info',
      textKey: 'groupWatch.rule.R38done',
      numbers: { files: 1, waitMin: 12, others: 2 },
      params: { path: panel('a.ts') },
      since: T('12:10:00'),
    });
  });

  it('перезапуск без ожидания: окно правок — десять минут до него, минут ожидания 0', () => {
    expect(
      restartByGroup(feed, [edit('12:15:00', panel('d.ts'))], T('12:30:00'), two)?.numbers,
    ).toEqual({ files: 1, waitMin: 0, others: 2 });
  });

  it('близкий промах: правка до окна, после перезапуска, чужой файл, полчаса прошли', () => {
    const at = T('12:30:00');
    expect(restartByGroup(feed, [edit('11:47:59', panel('a.ts'))], at, two)).toBeUndefined();
    expect(restartByGroup(feed, [edit('12:10:01', panel('a.ts'))], at, two)).toBeUndefined();
    expect(restartByGroup(feed, [edit('12:00:00', panel('z.ts'))], at, two)).toBeUndefined();
    // Отсрочку 12:20 снял «перезапуск не нужен»: окно d.ts — от 12:15, не от 12:10.
    expect(restartByGroup(feed, [edit('12:14:59', panel('d.ts'))], at, two)).toBeUndefined();
    expect(
      restartByGroup(feed, [edit('11:50:00', panel('a.ts'))], T('12:40:01'), two),
    ).toBeUndefined();
  });
});

describe('createRestartFeed: журнал и состояние dev-watch из каталога данных', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('журнал + прежний `.1`, когда нынешний моложе часа; ждущий перезапуск — пока жив его сторож', () => {
    dir = mkdtempSync(join(tmpdir(), 'restart-feed-'));
    writeFileSync(join(dir, `${DEV_WATCH_LOG}.1`), fixture('R39-restart-storm/fire.log'));
    writeFileSync(
      join(dir, DEV_WATCH_LOG),
      `2026-10-26T11:50:00.000Z перезапуск: ${panel('d.ts')}\n`,
    );
    const state = JSON.parse(fixture('R38-restart/dev-restart.json')) as Record<string, unknown>;
    writeFileSync(join(dir, DEV_RESTART_STATE), JSON.stringify({ ...state, pid: process.pid }));
    const feed = createRestartFeed(dir, ROOT, () => T('11:55:00'))();
    expect(feed.done.map((one) => one.at)).toEqual([
      T('11:05:00'),
      T('11:25:00'),
      T('11:40:00'),
      T('11:50:00'),
    ]);
    // dev-watch пишет ждущие файлы от корня дерева — сторож сводит их с полными путями правок.
    expect(feed.pending?.since).toBe(T('12:00:00'));
    expect(feed.pending?.files.map((file) => normPath(file))).toEqual([
      normPath(panel('a.ts')),
      normPath(panel('b.ts')),
    ]);
    const edits = [{ at: T('11:55:00'), path: normPath(panel('a.ts')) }];
    expect(restartByGroup(feed, edits, T('12:01:00'))?.numbers).toEqual({
      files: 1,
      waiting: 2,
      waitMin: 1,
    });
    expect(restartStorm(feed, GROUP_WATCH_DEFAULTS, T('11:55:00'))?.numbers).toEqual({
      restarts: 4,
    });
  });

  it('нынешний журнал старше часа — `.1` не читается; сторож перезапуска мёртв — не ждём', () => {
    dir = mkdtempSync(join(tmpdir(), 'restart-feed-'));
    writeFileSync(join(dir, `${DEV_WATCH_LOG}.1`), fixture('R39-restart-storm/fire.log'));
    writeFileSync(
      join(dir, DEV_WATCH_LOG),
      `2026-10-26T10:00:00.000Z перезапуск: ${panel('d.ts')}\n`,
    );
    writeFileSync(join(dir, DEV_RESTART_STATE), fixture('R38-restart/dev-restart.json'));
    const feed = createRestartFeed(dir, ROOT, () => T('11:55:00') + 10 * MIN)();
    expect(feed.done).toHaveLength(1);
    expect(feed.pending).toBeUndefined();
  });
});
