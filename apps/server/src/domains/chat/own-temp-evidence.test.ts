import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GROUP_REQUEST_DEFAULTS } from '@agentdeck/contracts/split-groups';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupDecision, withOwnTemp, type GroupAutoApprove } from './group-permissions.ts';

/**
 * Свой временный файл прошлого вызова (D-10/D-11, 26.10): рецензент группы
 * снимал копию в `/tmp`, правил файл, возвращал его и убирал копию — удаление
 * уходило человеку. Настоящие файлы во временном каталоге системы и настоящий
 * транскрипт субагента; суд — `withOwnTemp` + `groupDecision`, как в маршруте.
 */

const made: string[] = [];
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

const T0 = Date.now();
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
const use = (id: string, command: string, offsetMs: number, cwd: string): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at(offsetMs),
    cwd,
    isSidechain: true,
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  });
const result = (id: string, offsetMs: number, isError = false): string =>
  JSON.stringify({
    type: 'user',
    timestamp: at(offsetMs),
    isSidechain: true,
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'ok' }],
    },
  });

function stand() {
  const dir = mkdtempSync(join(tmpdir(), 'own-temp-'));
  made.push(dir);
  const copy = join(dir, 'shop-worktrees', 'fix-a');
  // Имя уникально на прогон: файлы лежат в настоящем `/tmp` системы.
  const stem = `ot${process.pid}${Math.random().toString(36).slice(2, 8)}`;
  /** Файл во временном каталоге — как `/tmp/<name>` у Git Bash и у разбора. */
  const temp = (name: string): string => {
    const path = join(tmpdir(), name);
    made.push(path);
    writeFileSync(path, 'backup');
    return path;
  };
  const group: GroupAutoApprove = {
    rows: { ...GROUP_REQUEST_DEFAULTS },
    allowEdits: true,
    worktree: copy,
    base: 'main',
    ownBranch: 'fix/a',
    ignored: [],
    shellCwd: copy,
    parentChatId: 'p',
    groupIndex: 0,
    tree: { dirty: false as const },
  };
  const judge = (lines: string[], command: string) => {
    const file = join(dir, 'agent-a.jsonl');
    writeFileSync(file, `${[...lines, use('toolu_now', command, 20_000, copy)].join('\n')}\n`);
    const request = { toolName: 'Bash', input: { command } };
    const owned = withOwnTemp(group, request, 'toolu_now', () => file);
    return { level: groupDecision(owned, { ...request, guardedPatterns: [] }), own: owned.ownTemp };
  };
  return { copy, stem, temp, judge, group };
}

describe('withOwnTemp — свой временный файл прошлого вызова', () => {
  it('D-10: копии `cp f /tmp/<stem>-*.bak` удавшимся вызовом — уборка шаблоном своя', () => {
    const { copy, stem, temp, judge } = stand();
    temp(`${stem}-c.bak`);
    temp(`${stem}-w.bak`);
    const backup = `cd ${copy} && F1=a.ts; cp $F1 /tmp/${stem}-c.bak && cp b.tsx /tmp/${stem}-w.bak`;
    const lines = [use('toolu_cp', backup, -5_000, copy), result('toolu_cp', 5_000)];
    const { level, own } = judge(lines, `rm /tmp/${stem}-*.bak`);
    expect(level).toBe('auto');
    expect([...(own ?? [])].map((path) => path.split('/').at(-1)).sort()).toEqual([
      `${stem}-c.bak`,
      `${stem}-w.bak`,
    ]);
  });

  it('D-11: `rm -f /tmp/KeyForm.<stem>.bak` после своего `cp` — своё; без улики — человеку', () => {
    const { copy, stem, temp, judge } = stand();
    temp(`KeyForm.${stem}.bak`);
    const rm = `rm -f /tmp/KeyForm.${stem}.bak`;
    const cp = `cp src/KeyForm.tsx /tmp/KeyForm.${stem}.bak`;
    expect(judge([use('toolu_cp', cp, -5_000, copy), result('toolu_cp', 5_000)], rm).level).toBe(
      'auto',
    );
    expect(judge([], rm).level).toBe('human');
  });

  it('запись перенаправлением `> /tmp/x.log` — тоже улика', () => {
    const { copy, stem, temp, judge } = stand();
    temp(`${stem}.log`);
    const lines = [
      use('toolu_log', `npm test > /tmp/${stem}.log 2>&1`, -5_000, copy),
      result('toolu_log', 5_000),
    ];
    expect(judge(lines, `rm /tmp/${stem}.log`).level).toBe('auto');
  });

  it('не своё — человеку: вызов упал, файл переписан позже, вызов после этого, только чтение', () => {
    const { copy, stem, temp, judge } = stand();
    const path = temp(`${stem}-c.bak`);
    const rm = `rm /tmp/${stem}-c.bak`;
    const cp = `cp a.ts /tmp/${stem}-c.bak`;
    expect(
      judge([use('toolu_cp', cp, -5_000, copy), result('toolu_cp', 5_000, true)], rm).level,
    ).toBe('human');
    expect(
      judge(
        [use('toolu_cat', `cat /tmp/${stem}-c.bak`, -5_000, copy), result('toolu_cat', 5_000)],
        rm,
      ).level,
    ).toBe('human');
    // Вызов с копией лёг в файл ПОСЛЕ этого — порядок не тот.
    const file = join(tmpdir(), `${stem}-order.jsonl`);
    made.push(file);
    writeFileSync(
      file,
      `${[use('toolu_now', rm, -10_000, copy), use('toolu_cp', cp, -5_000, copy), result('toolu_cp', 5_000)].join('\n')}\n`,
    );
    const { group } = stand();
    const request = { toolName: 'Bash', input: { command: rm } };
    expect(withOwnTemp(group, request, 'toolu_now', () => file).ownTemp).toBeUndefined();
    // Файл переписан через минуту после вызова — это уже не та копия.
    const later = new Date(T0 + 60_000);
    utimesSync(path, later, later);
    expect(judge([use('toolu_cp', cp, -5_000, copy), result('toolu_cp', 5_000)], rm).level).toBe(
      'human',
    );
  });

  it('этого вызова в транскрипте нет — какой вызов прошлый, не знать: человеку', () => {
    const { copy, stem, temp, group } = stand();
    temp(`${stem}-c.bak`);
    const rm = `rm /tmp/${stem}-c.bak`;
    const file = join(tmpdir(), `${stem}-other.jsonl`);
    made.push(file);
    // Улика есть, но файл чужого разговора: записи `toolu_now` в нём нет.
    const cp = `cp a.ts /tmp/${stem}-c.bak`;
    writeFileSync(
      file,
      `${[use('toolu_cp', cp, -5_000, copy), result('toolu_cp', 5_000)].join('\n')}\n`,
    );
    const request = { toolName: 'Bash', input: { command: rm } };
    expect(withOwnTemp(group, request, 'toolu_now', () => file).ownTemp).toBeUndefined();
  });

  it('`[` в каталоге — шаблон оболочки, хоть такой каталог и есть на диске: человеку', () => {
    const { copy, stem, judge } = stand();
    // Каталог с буквальным `[1]` в имени: оболочка прочтёт `[1]` как класс и сотрёт в `<stem>1`.
    const dir = join(tmpdir(), `${stem}[1]`);
    mkdirSync(dir);
    made.push(dir);
    writeFileSync(join(dir, `${stem}-c.bak`), 'backup');
    const path = `/tmp/${stem}[1]/${stem}-c.bak`;
    const lines = [use('toolu_cp', `cp a.ts ${path}`, -5_000, copy), result('toolu_cp', 5_000)];
    expect(judge(lines, `rm ${path}`).level).toBe('human');
  });

  it('шаблон с чужим совпадением на диске — человеку; шаблон в каталоге — человеку', () => {
    const { copy, stem, temp, judge } = stand();
    temp(`${stem}-c.bak`);
    temp(`${stem}-x.bak`);
    const lines = [
      use('toolu_cp', `cp a.ts /tmp/${stem}-c.bak`, -5_000, copy),
      result('toolu_cp', 5_000),
    ];
    expect(judge(lines, `rm /tmp/${stem}-*.bak`).level).toBe('human');
    expect(judge(lines, `rm /tmp/${stem}-c.bak`).level).toBe('auto');
    expect(judge(lines, `rm /tmp/*/${stem}-c.bak`).level).toBe('human');
  });

  it('команда без удаления временного — транскрипт не читается', () => {
    const { group } = stand();
    const locate = vi.fn(() => undefined);
    for (const command of ['cat /tmp/x.log | tail', 'rm src/a.ts && cat README.md']) {
      const request = { toolName: 'Bash', input: { command } };
      expect(withOwnTemp(group, request, 'toolu_now', locate)).toBe(group);
    }
    expect(locate).not.toHaveBeenCalled();
  });
});
