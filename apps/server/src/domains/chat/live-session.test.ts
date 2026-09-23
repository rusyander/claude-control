import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatRunRegistry, type BufferedEvent } from './ChatRunRegistry.ts';

/**
 * Живая сессия разговора — настоящий процесс, настоящие каналы, настоящий
 * реестр; подменён только сам CLI (`__fixtures__/fake-live-cli.mjs` говорит тем
 * же протоколом потокового ввода, что claude 2.1.280, замеренный 23.09.2026).
 *
 * Ради чего всё: процесс переживает конец хода — значит, переживают и фоновые
 * команды агента, которые прежде умирали вместе с `claude -p` на каждом ходе.
 */

const FAKE = fileURLToPath(new URL('./__fixtures__/fake-live-cli.mjs', import.meta.url));
const COMMAND = process.platform === 'win32' ? `"${process.execPath}" "${FAKE}"` : FAKE;
const SESSION = 'live-session-0001';

let cwd: string;
let registry: ChatRunRegistry;

beforeAll(() => {
  if (process.platform !== 'win32') chmodSync(FAKE, 0o755);
});

afterEach(() => {
  registry?.stopAll();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

function fresh(): void {
  cwd = mkdtempSync(join(tmpdir(), 'live-session-'));
  registry = new ChatRunRegistry();
}

async function waitFor(check: () => boolean, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Все события прогона из его буфера. */
function eventsOf(chatId: string): BufferedEvent['event'][] {
  const seen: BufferedEvent['event'][] = [];
  registry.attach(chatId, 0, { send: (buffered) => seen.push(buffered.event), close: () => {} });
  return seen;
}

function textOf(chatId: string): string {
  return eventsOf(chatId)
    .map((event) => (event.kind === 'text' ? event.text : ''))
    .join('');
}

async function turn(chatId: string, prompt: string, extra: Record<string, unknown> = {}) {
  const started = registry.start(
    chatId,
    { prompt, cwd, command: COMMAND, ...extra },
    { ...(extra.sessionId ? { sessionId: extra.sessionId as string } : {}) },
  );
  expect(started).toBe(true);
  await waitFor(() => !registry.isRunning(chatId));
  return textOf(chatId);
}

const pidIn = (text: string): string => /pid (\d+)/.exec(text)?.[1] ?? '';

// Настоящий процесс через cmd.exe: под нагрузкой полного прогона запуск node
// занимает секунды, а умолчание vitest — 5 с на тест.
describe('живая сессия разговора', { timeout: 30_000 }, () => {
  it('второй ход уходит в тот же процесс, и он жив между ходами', async () => {
    fresh();
    const first = await turn('new-1', 'привет');
    expect(first).toMatch(/^turn 1 pid \d+$/);
    expect(registry.livePool.size).toBe(1);

    const second = await turn('new-1', 'ещё', { sessionId: SESSION });
    // Тот же процесс помнит, что это его второй ход: при `-p` на ход здесь
    // был бы новый процесс и снова «turn 1».
    expect(second).toBe(`turn 2 pid ${pidIn(first)}`);

    // Прогресс спрашивает реестр, жив ли процесс: от этого зависит, идёт ли фон.
    expect(registry.isProcessAlive(SESSION)).toBe(true);
    registry.livePool.closeAll();
    expect(registry.isProcessAlive(SESSION)).toBe(false);
  });

  it('расход хода — разница, а не накопленный итог процесса', async () => {
    fresh();
    await turn('new-2', 'раз');
    await turn('new-2', 'два', { sessionId: SESSION });
    await turn('new-2', 'три', { sessionId: SESSION });
    const done = eventsOf('new-2').find((event) => event.kind === 'done');
    expect(done && done.kind === 'done' ? done.costUsd : -1).toBeCloseTo(0.01);
    // Накопленный итог CLI (0.01 + 0.02 + 0.03) задвоил бы счётчик.
    expect(registry.spend().costUsd).toBeCloseTo(0.03);
  });

  it('ход, начатый самим CLI, становится прогоном того же разговора', async () => {
    fresh();
    const first = await turn('new-3', 'WAKE');
    await waitFor(() => registry.describe('new-3')?.options.wake === true);
    await waitFor(() => !registry.isRunning('new-3'));
    expect(textOf('new-3')).toBe(`woke pid ${pidIn(first)}`);
    // И после него процесс ждёт следующего сообщения, а не уходит.
    const next = await turn('new-3', 'дальше', { sessionId: SESSION });
    expect(pidIn(next)).toBe(pidIn(first));
  });

  it('другие параметры запуска — новый процесс, прежний закрыт', async () => {
    fresh();
    const first = await turn('new-4', 'привет');
    const second = await turn('new-4', 'другой моделью', { sessionId: SESSION, model: 'opus' });
    expect(second).toMatch(/^turn 1 pid \d+$/);
    expect(pidIn(second)).not.toBe(pidIn(first));
    expect(registry.livePool.size).toBe(1);
  });

  it('брокер прав получает ключ ТЕКУЩЕГО хода, а не первого', async () => {
    fresh();
    const broker = (runId: string) => ({
      permissionMode: 'default',
      permissionPrompt: { runId, baseUrl: 'http://127.0.0.1:1' },
    });
    const argv = await turn('new-5', 'ARGV', broker('new-5'));
    const args = JSON.parse(argv.replace(/^argv /, '')) as string[];
    const config = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1]!, 'utf8')) as {
      mcpServers: { 'perm-guard': { env: Record<string, string> } };
    };
    const file = config.mcpServers['perm-guard'].env.PERM_RUN_ID_FILE!;
    expect(readFileSync(file, 'utf8')).toBe('new-5');

    await turn(SESSION, 'ещё', { sessionId: SESSION, ...broker(SESSION) });
    expect(readFileSync(file, 'utf8')).toBe(SESSION);
  });

  it('«Остановить» посреди хода валит процесс и убирает его из пула', async () => {
    fresh();
    registry.start('new-6', { prompt: 'SLOW', cwd, command: COMMAND }, {});
    await waitFor(() => textOf('new-6').startsWith('slow'));
    const pid = Number(pidIn(textOf('new-6')));
    registry.stop('new-6');
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(registry.livePool.size).toBe(0);
  });
});
