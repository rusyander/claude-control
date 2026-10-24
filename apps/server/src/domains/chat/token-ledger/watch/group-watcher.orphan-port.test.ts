import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GROUP_WATCH_DEFAULTS } from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../lib/app-store/app-store.types.ts';
import type { ChatEvent } from '../../chat-events.ts';
import { GroupWatcher } from './group-watcher.ts';

/**
 * R36 через сторож целиком: звено подняло свой сервер разработки (`vite --port 5284`
 * в фоне — НАСТОЯЩАЯ строка транскрипта 23.10, `__fixtures__/leak/R36-orphan-port/`),
 * группу поставили на паузу, а порт ещё слушает. Проба порта — снаружи правил
 * (`port-probe.ts`); здесь её ответ подставлен, сама проба проверена своим тестом.
 */

const MIN = 60_000;
const PORT = 5284;

interface Item {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
}
interface Row {
  timestamp: string;
  message: { content: Item[] | string };
}

const fixture = readFileSync(
  new URL('./__fixtures__/leak/R36-orphan-port/fire.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Row);

function setup() {
  let now = 0;
  const group = { index: 2, title: 'g', status: 'started' } as SplitPlanGroupRecord;
  const alive = new Set<number>();
  let id = 0;
  const watcher = new GroupWatcher({
    settings: () => ({ ...GROUP_WATCH_DEFAULTS }),
    resolve: (chatId) => ({ chatId, parentChatId: 'parent', groupIndex: 2, stage: 'work' }),
    group: (parent, index) => (parent === 'parent' && index === 2 ? group : undefined),
    save: () => {},
    node: () => ({
      running: group.status === 'started',
      paused: group.status === 'paused',
      ...(group.pausedAt ? { pausedAt: Date.parse(group.pausedAt) } : {}),
    }),
    portAlive: (port) => alive.has(port),
    now: () => now,
    makeId: () => `id${++id}`,
    plans: () => ({ parent: { groups: [group] } }),
  });
  const at = (t: number): void => {
    now = t;
  };
  /** Ход звена по вырезке: запуск сервера и ответ на него. Возвращает конец хода. */
  const launch = (): number => {
    const first = Date.parse(fixture[0]?.timestamp ?? '');
    at(first);
    watcher.onFeed('child', { kind: 'start', sessionId: 's1', cwd: '/w/app' });
    for (const row of fixture) {
      at(Date.parse(row.timestamp));
      const items = Array.isArray(row.message.content) ? row.message.content : [];
      for (const item of items) {
        const event: ChatEvent | undefined =
          item.type === 'tool_use' && item.id && item.name
            ? { kind: 'tool', id: item.id, name: item.name, input: item.input }
            : item.type === 'tool_result' && item.tool_use_id
              ? { kind: 'toolResult', toolUseId: item.tool_use_id, chars: 100 }
              : undefined;
        if (event) watcher.onFeed('child', { kind: 'event', event, sessionId: 's1' });
      }
    }
    const end = Date.parse(fixture.at(-1)?.timestamp ?? '') + 1000;
    at(end);
    watcher.onFeed('child', { kind: 'finish', sessionId: 's1' });
    return end;
  };
  /** Ещё один вызов Bash звена (и ответ на него) в той же сессии. */
  const bash = (command: string): void => {
    const tool = `bash${++id}`;
    watcher.onFeed('child', { kind: 'start', sessionId: 's1', cwd: '/w/app' });
    watcher.onFeed('child', {
      kind: 'event',
      event: { kind: 'tool', id: tool, name: 'Bash', input: { command } },
      sessionId: 's1',
    });
    watcher.onFeed('child', {
      kind: 'event',
      event: { kind: 'toolResult', toolUseId: tool, chars: 100 },
      sessionId: 's1',
    });
    watcher.onFeed('child', { kind: 'finish', sessionId: 's1' });
  };
  return {
    group,
    alive,
    launch,
    bash,
    pause: (t: number) => {
      at(t);
      group.status = 'paused';
      group.pausedAt = new Date(t).toISOString();
    },
    tickAt: (t: number) => {
      at(t);
      watcher.tick();
    },
    active: (rule: string) =>
      (group.watch?.signals ?? []).find((signal) => signal.rule === rule && !signal.clearedAt),
  };
}

describe('R36: свой сервер звена пережил паузу группы', () => {
  it('порт из `--port` слушает дольше двух минут после паузы — внимание, порт назван', () => {
    const w = setup();
    const end = w.launch();
    w.alive.add(PORT);
    w.pause(end + MIN);
    w.tickAt(end + 2 * MIN);
    expect(w.active('R36')).toBeUndefined();
    w.tickAt(end + 4 * MIN);
    expect(w.active('R36')).toMatchObject({
      severity: 'warn',
      numbers: { ports: 1 },
      params: { port: String(PORT) },
    });
  });

  it('сигнал держится, пока порт слушает: сессия не забывается по простою; порт закрыт — снят', () => {
    const w = setup();
    const end = w.launch();
    w.alive.add(PORT);
    w.pause(end + MIN);
    w.tickAt(end + 4 * MIN);
    w.tickAt(end + 40 * MIN);
    expect(w.active('R36')).toBeDefined();
    w.alive.delete(PORT);
    w.tickAt(end + 41 * MIN);
    expect(w.active('R36')).toBeUndefined();
  });

  it('порт закрыт к паузе — тишина', () => {
    const w = setup();
    const end = w.launch();
    w.pause(end + MIN);
    w.tickAt(end + 5 * MIN);
    expect(w.active('R36')).toBeUndefined();
  });

  it('слушает чужой порт (не названный звеном) — тишина', () => {
    const w = setup();
    const end = w.launch();
    w.alive.add(5173);
    w.pause(end + MIN);
    w.tickAt(end + 5 * MIN);
    expect(w.active('R36')).toBeUndefined();
  });

  it('порт клиента (`psql -p`, `ssh -p`, `redis-cli -p`) — не свой сервер: его слушает чужой, тишина', () => {
    // База человека слушает всегда: подключение к ней ключом `-p` сервера не поднимает.
    const w = setup();
    const end = w.launch();
    w.bash('psql -h localhost -p 5432 -U app -c "select 1"');
    w.bash('ssh -p 2222 dev@host uptime; redis-cli -p 6379 ping');
    w.bash('docker exec db pg_dump -p 5433 app > /dev/null');
    for (const port of [5432, 2222, 6379, 5433]) w.alive.add(port);
    w.pause(end + MIN);
    w.tickAt(end + 5 * MIN);
    expect(w.active('R36')).toBeUndefined();
    // Свой сервер в той же сессии по-прежнему виден.
    w.alive.add(PORT);
    w.tickAt(end + 6 * MIN);
    expect(w.active('R36')).toMatchObject({ params: { port: String(PORT) } });
  });

  it('группа идёт, сервер звена жив — это работа, не сирота', () => {
    const w = setup();
    const end = w.launch();
    w.alive.add(PORT);
    w.tickAt(end + 5 * MIN);
    expect(w.active('R36')).toBeUndefined();
  });
});
