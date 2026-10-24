import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatRun, type RunOptions } from './ChatRunner.ts';
import type { ChatEvent } from '../chat-events.ts';
import { LiveSessionPool } from '../live-session/live-session.ts';
import { runWarmPing } from '../ChatRunRegistry/warm-ping.ts';
import { denyToolsCommand, withDenyToolsHook } from './deny-tools.ts';

/**
 * Пинг тёплого кэша без инструментов и без зависания — по настоящему пути:
 * процесс `ChatRun`, файл `--settings`, который он пишет, хук-скрипт, который
 * CLI запустил бы оболочкой, и снятие дерева процессов по потолку времени.
 * Подменён только CLI (`fake-live-cli.mjs`: TOOLHOOK зовёт первый хук
 * `PreToolUse` из файла настроек так, как CLI; HANG не отвечает и не выходит).
 */

const FAKE = fileURLToPath(new URL('../__fixtures__/fake-live-cli.mjs', import.meta.url));
const COMMAND = process.platform === 'win32' ? `"${process.execPath}" "${FAKE}"` : FAKE;

let cwd: string | undefined;
let pool: LiveSessionPool | undefined;

beforeAll(() => {
  if (process.platform !== 'win32') chmodSync(FAKE, 0o755);
});

afterEach(() => {
  pool?.closeAll();
  pool = undefined;
  if (!cwd) return;
  try {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    /* папку держит умирающий процесс */
  }
  cwd = undefined;
});

function options(prompt: string, over: Partial<RunOptions> = {}): RunOptions {
  cwd ??= mkdtempSync(join(tmpdir(), 'deny-tools-'));
  return {
    prompt,
    cwd,
    command: COMMAND,
    sessionId: 'group-session',
    fork: true,
    ephemeral: true,
    ...over,
  };
}

async function textOf(run: RunOptions): Promise<string> {
  pool = new LiveSessionPool();
  let text = '';
  await new ChatRun(pool).start(run, (event: ChatEvent) => {
    if (event.kind === 'text') text += event.text;
  });
  return text;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('пинг без инструментов (denyTools)', { timeout: 30_000 }, () => {
  it('хук из файла --settings отклоняет вызов кодом 2 с объяснением модели', async () => {
    const text = await textOf(options('TOOLHOOK', { denyTools: true }));
    expect(text).toContain('hook exit 2');
    expect(text).toContain('Tools are disabled for this keep-alive turn');
  });

  it('хук вливается в настройки маршрута, а не заменяет их; без флага его нет (контроль)', async () => {
    const route = { matcher: 'Bash', hooks: [{ type: 'command', command: 'route-hook' }] };
    const text = await textOf(
      options('TOOLHOOK', {
        denyTools: true,
        platformSettings: { hooks: { PreToolUse: [route] }, skillOverrides: { a: 'off' } },
      }),
    );
    expect(text).toContain('hook exit 2');
    const merged = withDenyToolsHook({ PreToolUse: [route], Stop: [] });
    expect(merged.PreToolUse).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: denyToolsCommand() }] },
      route,
    ]);
    expect(merged.Stop).toEqual([]);
    expect(await textOf(options('TOOLHOOK'))).toContain('hook none');
  });
});

describe('зависший пинг', { timeout: 30_000 }, () => {
  it('потолок времени отдаёт исход сам и снимает процесс CLI', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'hang-')), 'pid');
    pool = new LiveSessionPool();
    const started = Date.now();
    const outcome = await runWarmPing(
      new ChatRun(pool),
      options(`HANG ${pidFile}`),
      Date.now,
      2_000,
    );
    expect(outcome).toMatchObject({ ok: false, error: 'timeout' });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const deadline = Date.now() + 10_000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
  });

  it('снятие не подтвердилось (процесс не отпускает ход) — исход всё равно отдан, с пометкой', async () => {
    let stops = 0;
    const stuck = {
      start: () => new Promise<void>(() => undefined),
      stop: (): 'unconfirmed' => {
        stops += 1;
        return 'unconfirmed';
      },
    };
    const outcome = await runWarmPing(stuck, options('w'), Date.now, 50);
    expect(outcome).toMatchObject({ ok: false, error: 'timeout', stopUnconfirmed: true });
    expect(stops).toBe(1);
  });

  it('события снятого по потолку процесса после исхода не трогают его: второго снятия нет', async () => {
    let stops = 0;
    let emit: (event: ChatEvent) => void = () => undefined;
    const stuck = {
      start: (_options: unknown, onEvent: (event: ChatEvent) => void) => {
        emit = onEvent;
        return new Promise<void>(() => undefined);
      },
      stop: (): void => {
        stops += 1;
      },
    };
    const outcome = await runWarmPing(stuck, options('w'), Date.now, 50);
    expect(outcome).toMatchObject({ ok: false, error: 'timeout' });
    expect(stops).toBe(1);
    // Процесс ещё дописывает поток: вызов инструмента и расход уже ни на что не влияют.
    emit({ kind: 'tool', id: 't1', name: 'Bash', input: {} } as unknown as ChatEvent);
    emit({ kind: 'usage', input: 5, cacheRead: 7, cacheCreation: 0, output: 1 } as ChatEvent);
    expect(stops).toBe(1);
    expect(outcome.toolStopped).toBeUndefined();
    expect(outcome.usage).toMatchObject({ input: 0, cacheRead: 0 });
  });
});

describe('оборванный пинг, дошедший до модели', { timeout: 30_000 }, () => {
  // Расход начала хода (`message_start`): вход и кэш уже прочитаны моделью и
  // оплачены, а `message_delta`, который их отдаёт обычным путём, не придёт.
  const STARTED = { input: 3, cacheRead: 120_000, cacheWrite: 300, cacheWrite1h: 300 };

  it('вызов инструмента оборвал ход до его расхода — расход начала хода в исходе', async () => {
    pool = new LiveSessionPool();
    const outcome = await runWarmPing(new ChatRun(pool), options('STARTTOOL'), Date.now, 10_000);
    expect(outcome).toMatchObject({ ok: false, toolStopped: true, usage: STARTED });
  });

  it('потолок времени после начала ответа — расход начала хода в исходе', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'start-hang-')), 'pid');
    pool = new LiveSessionPool();
    try {
      const outcome = await runWarmPing(
        new ChatRun(pool),
        options(`STARTONLY ${pidFile}`),
        Date.now,
        // Потолок обязан сработать ПОСЛЕ начала хода: под нагрузкой всего набора
        // запуск поддельного CLI занимал больше 2 с, и исход приходил без расхода.
        8_000,
      );
      expect(outcome).toMatchObject({ ok: false, error: 'timeout', usage: STARTED });
    } finally {
      rmSync(join(pidFile, '..'), { recursive: true, force: true });
    }
  });

  it('ход дошёл до конца — расход один раз: начало хода закрыл его расход', async () => {
    const whole = {
      start: async (_options: unknown, onEvent: (event: ChatEvent) => void) => {
        onEvent({ kind: 'turnStart', input: 3, cacheRead: 120_000, cacheCreation: 300 });
        onEvent({ kind: 'usage', input: 3, cacheRead: 120_000, cacheCreation: 300, output: 2 });
      },
      stop: () => undefined,
    };
    const outcome = await runWarmPing(whole, options('w'), Date.now, 5_000);
    expect(outcome).toMatchObject({
      ok: true,
      usage: { input: 3, cacheRead: 120_000, cacheWrite: 300, output: 2 },
    });
  });

  it('обычный разговор (не пинг) начала хода отдельным событием не видит', async () => {
    pool = new LiveSessionPool();
    const kinds: string[] = [];
    const run = new ChatRun(pool);
    const done = run.start(options('STARTTOOL', { ephemeral: false, fork: false }), (event) => {
      kinds.push(event.kind);
      if (event.kind === 'tool') run.stop();
    });
    await done;
    expect(kinds).toContain('tool');
    expect(kinds).not.toContain('turnStart');
  });
});
