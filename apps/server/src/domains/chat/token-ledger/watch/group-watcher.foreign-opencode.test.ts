import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GROUP_WATCH_DEFAULTS, type GroupWatch } from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../lib/app-store/app-store.types.ts';
import {
  ROOT_SESSION,
  appendOpencodeRows,
  deniedTurn,
  writeOpencodeDb,
} from '../foreign/opencode-db.fixture.ts';
import { opencodeRef } from '../foreign/opencode-db.ts';
import { GroupWatcher } from './group-watcher.ts';
import { SessionTranscripts } from './group-watcher/session-transcripts.ts';
import type { Session } from './group-watcher/group-watcher.types.ts';

/**
 * Сторож над сессией OpenCode в его базе SQLite: база общая на все сессии и
 * переписывается каждой записью CLI, а правила видят каждую запись ровно один раз —
 * отказы набираются в стену (R18) по числу отказов, а не по числу перечитываний.
 * Схема базы и строки — запись НАСТОЯЩЕГО opencode 1.18.35
 * (`foreign/__fixtures__/opencode-1.18-session.json`), текст отказа — его собственный.
 */

const MIN = 60_000;
/** Ход начат за минуту до рождения сессии записи (1793098076635): сессия — этого хода. */
const T0 = 1793098000000;

describe('GroupWatcher над базой OpenCode', () => {
  let dir: string;
  let db: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gw-opencode-'));
    db = join(dir, 'opencode.db');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** База с одной корневой сессией записи без сообщений, рождённой в `born`. */
  function emptySession(born: number): void {
    writeOpencodeDb(db, (rows) => {
      rows.session = rows.session
        .filter((row) => row.id === ROOT_SESSION)
        .map((row) => ({ ...row, time_created: born }));
      rows.message = [];
      rows.part = [];
    });
  }

  function watch(t0: number) {
    let now = t0;
    const settings: GroupWatch = { ...GROUP_WATCH_DEFAULTS };
    const group = { index: 1, title: 'g', status: 'started' } as SplitPlanGroupRecord;
    const chat = 'opencode:child';
    const asked: string[] = [];
    const watcher = new GroupWatcher({
      settings: () => settings,
      resolve: (chatId) =>
        chatId === chat
          ? { chatId, parentChatId: 'parent', groupIndex: 1, stage: 'work', cwd: dir }
          : undefined,
      group: (parent, index) => (parent === 'parent' && index === 1 ? group : undefined),
      save: () => {},
      node: () => ({ running: true, paused: false }),
      // Первый ход: на месте id — ключ разговора; ссылка та же, что после смены id.
      transcript: (id, hint) => {
        asked.push(id);
        return hint?.provider === 'opencode' ? opencodeRef(db, ROOT_SESSION) : undefined;
      },
      subagentDir: () => {
        throw new Error('subagentDir must not be asked for a foreign session');
      },
      now: () => now,
      makeId: () => 'id',
      plans: () => ({ parent: { groups: [group] } }),
      log: (message, error) => {
        throw new Error(`watcher swallowed: ${message} ${String(error)}`);
      },
    });
    const start = () =>
      watcher.onFeed(chat, {
        kind: 'start',
        sessionId: chat,
        cwd: dir,
        detached: true,
        provider: 'opencode',
      });
    return {
      start,
      asked,
      /** CLI дописал ход в базу, тик сторожа через минуту. */
      run: (rows?: Parameters<typeof appendOpencodeRows>[1]) => {
        if (rows) appendOpencodeRows(db, rows);
        now += MIN;
        watcher.tick();
        return (group.watch?.signals ?? []).filter((signal) => !signal.clearedAt);
      },
    };
  }

  it('пять отказов человека — R18 (permission), четыре — нет', () => {
    emptySession(T0 + 1000);
    const four = watch(T0);
    four.start();
    expect(
      four.run(deniedTurn(ROOT_SESSION, T0 + 30_000, 4, 'a')).map((s) => s.rule),
    ).not.toContain('R18');
    expect(four.asked).toContain('opencode:child');

    rmSync(db);
    emptySession(T0 + 1000);
    const five = watch(T0);
    five.start();
    const r18 = five
      .run(deniedTurn(ROOT_SESSION, T0 + 30_000, 5, 'b'))
      .find((signal) => signal.rule === 'R18');
    expect(r18?.numbers).toMatchObject({ denials: 5 });
    expect(r18?.params).toMatchObject({ guard: 'permission' });
  });

  it('база переписана записью CLI — счёт по записям, не по чтениям', () => {
    emptySession(T0 + 1000);
    const w = watch(T0);
    w.start();
    expect(w.run(deniedTurn(ROOT_SESSION, T0 + 30_000, 3, 'a')).map((s) => s.rule)).not.toContain(
      'R18',
    );
    // Те же три в базе + два новых: перечитай сторож сессию без памяти — было бы восемь.
    const r18 = w
      .run(deniedTurn(ROOT_SESSION, T0 + 90_000, 2, 'b'))
      .find((signal) => signal.rule === 'R18');
    expect(r18?.numbers).toMatchObject({ denials: 5 });
  });

  it('подхват после перезапуска панели: сессия, начатая до хода, не догоняется', () => {
    emptySession(T0 - 60 * MIN);
    // Отказы прошлого хода — внутри окна R18 (15 мин): догони их сторож, R18 загорелось бы.
    appendOpencodeRows(db, deniedTurn(ROOT_SESSION, T0 - 5 * MIN, 5, 'old'));
    const w = watch(T0);
    w.start();
    expect(w.run().map((s) => s.rule)).not.toContain('R18');
    // Дописанное после подхвата читается: пять новых отказов — R18.
    expect(w.run(deniedTurn(ROOT_SESSION, T0 + 90_000, 5, 'new')).map((s) => s.rule)).toContain(
      'R18',
    );
  });

  it('база окна продолженной сессии — её первый вызов, не нынешнее окно', () => {
    writeOpencodeDb(db);
    const files = new SessionTranscripts({
      transcript: (id, hint) => (hint?.provider === 'opencode' ? opencodeRef(db, id) : undefined),
    } as ConstructorParameters<typeof SessionTranscripts>[0]);
    const session = {
      provider: 'opencode',
      sessionId: ROOT_SESSION,
      target: { cwd: dir },
      state: {},
      keys: new Set<string>(),
    } as unknown as Session;
    files.bound(session, ROOT_SESSION, undefined, T0);
    // Первый запрос записи: 400 новых + 600 из кэша (субагент в базу не идёт).
    expect(session.state.firstCtx).toBe(1000);
  });
});
