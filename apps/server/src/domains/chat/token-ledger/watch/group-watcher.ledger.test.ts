import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GROUP_WATCH_DEFAULTS, type GroupSignal } from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../lib/app-store/app-store.types.ts';
import type { ChatEvent } from '../../chat-events.ts';
import { createLedgerFeed, GroupWatcher, type RestartFeed } from './group-watcher.ts';

/**
 * Журналы панели вне сессии на тике сторожа целиком (поток → свёртка → обход групп →
 * сигналы записи группы): R38/R39 — перезапуски сервера панели, R40/R41 — журнал
 * проверок. Подменены только часы и ответ журнала dev-watch; журнал проверок — настоящий
 * читатель над временным `events.jsonl` из вырезок.
 */

const APP = 'C:\\work\\app';
const T = (hms: string): number => Date.parse(`2026-10-26T${hms}Z`);
const panel = (file: string) => `C:\\work\\panel\\apps\\server\\src\\${file}`;
const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/leak/${name}`, import.meta.url), 'utf8');

let dir = '';
/** Каждый `setup` — свой каталог; тест с двумя процессами сторожа заводит два. */
const dirs: string[] = [];
afterEach(() => {
  for (const one of dirs.splice(0)) rmSync(one, { recursive: true, force: true });
  dir = '';
});

function setup(
  options: {
    ledger?: string;
    restarts?: RestartFeed;
    editsFile?: string;
    others?: SplitPlanGroupRecord[];
    now?: number;
  } = {},
) {
  dir = mkdtempSync(join(tmpdir(), 'watch-ledger-'));
  dirs.push(dir);
  if (options.ledger) writeFileSync(join(dir, 'events.jsonl'), fixture(options.ledger));
  let now = options.now ?? T('09:00:00');
  const group = {
    index: 3,
    title: 'g3',
    status: 'started',
    chatId: 'child-3',
    path: APP,
  } as SplitPlanGroupRecord;
  const notified: GroupSignal[] = [];
  let id = 0;
  const watcher = new GroupWatcher({
    settings: () => GROUP_WATCH_DEFAULTS,
    resolve: (chatId) =>
      chatId === 'child-3' ? { chatId, parentChatId: 'parent', groupIndex: 3 } : undefined,
    group: (parent, index) => (parent === 'parent' && index === 3 ? group : undefined),
    save: () => {},
    node: () => ({ running: true, paused: false }),
    notify: (signal) => notified.push(signal),
    now: () => now,
    makeId: () => `id${++id}`,
    plans: () => ({ parent: { groups: [group, ...(options.others ?? [])] } }),
    ledger: createLedgerFeed(dir, () => now),
    ...(options.restarts ? { restartFeed: () => options.restarts! } : {}),
    ...(options.editsFile ? { editsFile: options.editsFile } : {}),
  });
  watcher.onFeed('child-3', { kind: 'start', sessionId: 's3', cwd: APP });
  return {
    watcher,
    notified,
    at: (t: number) => {
      now = t;
    },
    event: (event: ChatEvent) =>
      watcher.onFeed('child-3', { kind: 'event', event, sessionId: 's3' }),
    active: (rule: string) =>
      (group.watch?.signals ?? []).filter((s) => s.rule === rule && !s.clearedAt),
  };
}

const bash = (toolId: string, command: string): ChatEvent => ({
  kind: 'tool',
  id: toolId,
  name: 'Bash',
  input: { command },
});
const result = (toolId: string) =>
  ({ kind: 'toolResult', toolUseId: toolId, chars: 100 }) as ChatEvent;

function runCheck(w: ReturnType<typeof setup>, command = 'npx vitest run src/app.test.ts') {
  w.at(T('10:00:00'));
  w.event(bash('t1', command));
  w.at(T('10:00:40'));
  w.event(result('t1'));
}

describe('GroupWatcher R41 проверка группы мимо журнала', () => {
  it('vitest run шёл 40 с, из копии ни события — через 20 с после конца сведение на записи группы, без Telegram', () => {
    const w = setup({ ledger: 'R41-gap/fire.jsonl' });
    runCheck(w);
    w.at(T('10:00:50'));
    w.watcher.tick();
    expect(w.active('R41')).toEqual([]);
    w.at(T('10:01:10'));
    w.watcher.tick();
    expect(w.active('R41')).toMatchObject([
      {
        severity: 'info',
        numbers: { runs: 1, ranSec: 40 },
        params: { check: 'vitest' },
        textKey: 'groupWatch.rule.R41',
      },
    ]);
    // Сведение не уходит наружу (F5).
    expect(w.notified.filter((s) => s.rule === 'R41')).toEqual([]);
  });

  it('близкий промах: запись прогона легла в окно; команда — не проверка журнала; прогон до начала ленты', () => {
    const near = setup({ ledger: 'R41-gap/near-miss.jsonl' });
    runCheck(near);
    near.at(T('10:02:00'));
    near.watcher.tick();
    expect(near.active('R41')).toEqual([]);
    rmSync(dir, { recursive: true, force: true });

    const plain = setup({ ledger: 'R41-gap/fire.jsonl' });
    runCheck(plain, 'node tools/qa/check-help.mjs');
    plain.at(T('10:02:00'));
    plain.watcher.tick();
    expect(plain.active('R41')).toEqual([]);
    rmSync(dir, { recursive: true, force: true });

    const before = setup({ ledger: 'R41-gap/before-feed.jsonl' });
    runCheck(before);
    before.at(T('10:06:00'));
    before.watcher.tick();
    expect(before.active('R41')).toEqual([]);
  });

  it('проверка, отбитая стражем (не шла), и фоновый прогон (длительности нет) — не GAP', () => {
    const w = setup({ ledger: 'R41-gap/fire.jsonl' });
    w.at(T('10:00:00'));
    w.event(bash('d1', 'npx vitest run src/app.test.ts'));
    w.event({
      kind: 'toolResult',
      toolUseId: 'd1',
      chars: 80,
      denied: 'gate-at-end',
    } as ChatEvent);
    w.event({
      ...bash('b1', 'npx tsc --noEmit'),
      input: { command: 'npx tsc --noEmit', run_in_background: true },
    } as ChatEvent);
    w.at(T('10:00:40'));
    w.event(result('b1'));
    w.at(T('10:02:00'));
    w.watcher.tick();
    expect(w.active('R41')).toEqual([]);
  });
});

describe('GroupWatcher R40 журнал проверок в копии группы', () => {
  it('находки журнала в копии группы — сведение по последней; близкий промах молчит', () => {
    const w = setup({ ledger: 'R40-ledger/fire.jsonl' });
    w.at(T('09:25:00'));
    w.watcher.tick();
    expect(w.active('R40')).toMatchObject([
      {
        severity: 'info',
        numbers: { findings: 4 },
        params: { check: 'vitest', mode: 'shadow' },
        textKey: 'groupWatch.rule.R40mode',
      },
    ]);
    rmSync(dir, { recursive: true, force: true });

    const near = setup({ ledger: 'R40-ledger/near-miss.jsonl' });
    near.at(T('09:25:00'));
    near.watcher.tick();
    expect(near.active('R40')).toEqual([]);
  });
});

describe('GroupWatcher R38/R39 перезапуски сервера панели', () => {
  it('правка группы держит ждущий перезапуск — R38; три перезапуска за час — R39', () => {
    const w = setup({
      restarts: {
        done: [
          { at: T('11:05:00'), files: [] },
          { at: T('11:25:00'), files: [] },
          { at: T('11:40:00'), files: [] },
        ],
        pending: { since: T('12:00:00'), files: [panel('a.ts'), panel('b.ts')] },
      },
    });
    w.at(T('11:55:00'));
    w.event({ kind: 'tool', id: 'e1', name: 'Edit', input: { file_path: panel('a.ts') } });
    w.event(result('e1'));
    w.at(T('12:01:00'));
    w.watcher.tick();
    expect(w.active('R38')).toMatchObject([
      {
        severity: 'info',
        textKey: 'groupWatch.rule.R38wait',
        numbers: { files: 1, waiting: 2, waitMin: 1 },
        params: { path: panel('a.ts') },
      },
    ]);
    expect(w.active('R39')).toMatchObject([{ severity: 'info', numbers: { restarts: 3 } }]);
  });

  it('перезапуск из-за правки группы уже случился: правка пережила процесс в файле — R38done', () => {
    const data = mkdtempSync(join(tmpdir(), 'watch-edits-'));
    dirs.push(data);
    const editsFile = join(data, 'group-watch-edits.json');
    const before = setup({
      restarts: { done: [], pending: { since: T('12:00:00'), files: [panel('a.ts')] } },
      editsFile,
    });
    before.at(T('11:55:00'));
    before.event({ kind: 'tool', id: 'e1', name: 'Edit', input: { file_path: panel('a.ts') } });
    // Новый процесс после перезапуска: память сторожа пуста, правка — только в файле.
    const g4 = { index: 4, title: 'g4', status: 'started', startedAt: '2026-10-26T11:00:00Z' };
    const g5 = { index: 5, title: 'g5', status: 'started', startedAt: '2026-10-26T12:30:00Z' };
    const after = setup({
      restarts: {
        done: [{ at: T('12:10:00'), files: [panel('a.ts')], deferredAt: T('12:00:00') }],
      },
      editsFile,
      others: [g4, g5] as SplitPlanGroupRecord[],
      now: T('12:40:00'),
    });
    after.watcher.tick();
    expect(after.active('R38')).toMatchObject([
      {
        textKey: 'groupWatch.rule.R38done',
        numbers: { files: 1, waitMin: 10, others: 1 },
        params: { path: panel('a.ts') },
      },
    ]);
    // Полчаса после перезапуска прошли — заметка закрыта.
    after.at(T('12:40:01'));
    after.watcher.tick();
    expect(after.active('R38')).toEqual([]);
  });

  it('близкий промах после перезапуска: файла правок нет — сторож не знает, чья правка', () => {
    const w = setup({
      restarts: {
        done: [{ at: T('12:10:00'), files: [panel('a.ts')], deferredAt: T('12:00:00') }],
      },
      now: T('12:20:00'),
    });
    w.watcher.tick();
    expect(w.active('R38')).toEqual([]);
  });

  it('близкий промах: правка чужого файла и два перезапуска за час — молчат', () => {
    const w = setup({
      restarts: {
        done: [
          { at: T('11:25:00'), files: [] },
          { at: T('11:40:00'), files: [] },
        ],
        pending: { since: T('12:00:00'), files: [panel('a.ts')] },
      },
    });
    w.at(T('11:55:00'));
    w.event({ kind: 'tool', id: 'e1', name: 'Edit', input: { file_path: panel('z.ts') } });
    w.event(result('e1'));
    w.at(T('12:01:00'));
    w.watcher.tick();
    expect(w.active('R38')).toEqual([]);
    expect(w.active('R39')).toEqual([]);
  });
});
