import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GROUP_WATCH_DEFAULTS, type GroupWatch } from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../lib/app-store/app-store.types.ts';
import { GroupWatcher } from './group-watcher.ts';

/**
 * Сторож над перепиской-документом Continue (`cn`): документ переписывается целиком,
 * и правила видят каждую запись ровно один раз — отказы набираются в стену (R18) по
 * числу отказов, а не по числу перечитываний. Документ — форма НАСТОЯЩЕГО `cn` 1.5.47
 * (`foreign/__fixtures__/continue-1.5-list.json`), отказ — текст его исходника.
 */

const MIN = 60_000;
const FIXTURE = readFileSync(
  join(import.meta.dirname, '..', 'foreign', '__fixtures__', 'continue-1.5-list.json'),
  'utf8',
);

/** Документ: реальная запись + `n` отбитых вызовов оболочки в одном ответе модели. */
function withDenials(n: number): string {
  const doc = JSON.parse(FIXTURE) as { history: Array<Record<string, unknown>> };
  const states = Array.from({ length: n }, (_, i) => ({
    toolCallId: `deny_${i}`,
    toolCall: {
      id: `deny_${i}`,
      function: { name: 'Bash', arguments: JSON.stringify({ command: `git push try-${i}` }) },
    },
    status: 'canceled',
    parsedArgs: { command: `git push try-${i}` },
    output: [{ content: 'Permission denied by user' }],
  }));
  doc.history.push({
    message: {
      role: 'assistant',
      content: '',
      usage: {
        prompt_tokens: 1400,
        prompt_tokens_details: { cached_tokens: 1300 },
        completion_tokens: 9,
      },
    },
    toolCallStates: states,
  });
  return JSON.stringify(doc);
}

describe('GroupWatcher над документом Continue', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gw-foreign-doc-'));
    file = join(dir, 'session.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function watch(t0: number) {
    let now = t0;
    const settings: GroupWatch = { ...GROUP_WATCH_DEFAULTS };
    const group = { index: 1, title: 'g', status: 'started' } as SplitPlanGroupRecord;
    const chat = 'continue:child';
    const watcher = new GroupWatcher({
      settings: () => settings,
      resolve: (chatId) =>
        chatId === chat
          ? { chatId, parentChatId: 'parent', groupIndex: 1, stage: 'work', cwd: dir }
          : undefined,
      group: (parent, index) => (parent === 'parent' && index === 1 ? group : undefined),
      save: () => {},
      node: () => ({ running: true, paused: false }),
      transcript: (_id, hint) => (hint?.provider === 'continue' ? file : undefined),
      subagentDir: () => {
        throw new Error('subagentDir must not be asked for a foreign session');
      },
      now: () => now,
      makeId: () => 'id',
      plans: () => ({ parent: { groups: [group] } }),
    });
    const start = () =>
      watcher.onFeed(chat, {
        kind: 'start',
        sessionId: chat,
        cwd: dir,
        detached: true,
        provider: 'continue',
      });
    return {
      start,
      /** Документ переписан, тик сторожа через минуту. */
      run: (text: string) => {
        writeFileSync(file, text);
        now += MIN;
        watcher.tick();
        return (group.watch?.signals ?? []).filter((signal) => !signal.clearedAt);
      },
    };
  }

  // Время сторожа — сейчас: файл, записанный в тесте, родился в этом ходе.
  const NOW = Date.now();

  it('пять отказов — R18 (permission), четыре — нет', () => {
    const four = watch(NOW);
    four.start();
    expect(four.run(withDenials(4)).map((s) => s.rule)).not.toContain('R18');
    const five = watch(NOW);
    five.start();
    const r18 = five.run(withDenials(5)).find((signal) => signal.rule === 'R18');
    expect(r18?.numbers).toMatchObject({ denials: 5 });
    expect(r18?.params).toMatchObject({ guard: 'permission' });
  });

  it('документ переписан с теми же отказами и ещё двумя — счёт по записям, не по чтениям', () => {
    const w = watch(NOW);
    w.start();
    expect(w.run(withDenials(3)).map((s) => s.rule)).not.toContain('R18');
    // Те же три + два новых: перечитай сторож документ без памяти — было бы восемь.
    const r18 = w.run(withDenials(5)).find((signal) => signal.rule === 'R18');
    expect(r18?.numbers).toMatchObject({ denials: 5 });
  });

  it('подхват после перезапуска панели: документ, начатый до хода, не догоняется', () => {
    writeFileSync(file, withDenials(5));
    // Ход начат через час после рождения файла.
    const w = watch(NOW + 60 * MIN);
    w.start();
    expect(w.run(withDenials(5)).map((s) => s.rule)).not.toContain('R18');
  });
});
