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
  // Убитый CLI отпускает папку не мгновенно: под нагрузкой Windows отвечает EPERM
  // и дольше секунды повторов (полный прогон 23.09). Уборка временной папки — не
  // предмет теста: не отпустилась — остаётся системе, а не роняет проверку.
  if (!cwd) return;
  try {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    /* папку держит умирающий процесс */
  }
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

  // Аудит 25.09, L280: заглушка CLI в живом потоке — ни текста, ни шага расхода.
  it('заглушка <synthetic> в живом ходе не даёт ни текста, ни расхода', async () => {
    fresh();
    const text = await turn('new-syn', 'SYNTHETIC');
    expect(text).toMatch(/^turn 1 pid \d+$/);
    const models = eventsOf('new-syn').flatMap((event) =>
      event.kind === 'usage' ? [event.model ?? ''] : [],
    );
    expect(models).not.toContain('<synthetic>');
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

  // Живой прогон 06.10: «Продолжить» групп, чей процесс умер с фоновой командой.
  // CLI сперва закрывал свой ход уведомления пустым `result`, панель принимала его
  // за конец хода человека и заводила доставку, а настоящий ход уходил «пробуждением»
  // в тот же чат — две сессии в одной копии.
  it('итог хода уведомления CLI не закрывает ход человека', async () => {
    fresh();
    const finished: { text: string; ok: boolean }[] = [];
    registry.setHandoffPlanner((run) => {
      finished.push({ text: run.text, ok: run.ok });
      return undefined;
    });
    const text = await turn('new-ghost', 'GHOST');
    expect(text).toMatch(/^turn 1 pid \d+$/);
    expect(finished).toEqual([{ text, ok: true }]);
    // Настоящий ход достался прогону человека — пробуждения под него не заводили.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(registry.describe('new-ghost')?.options.wake).toBeUndefined();
    expect(finished).toHaveLength(1);
  });

  it('другие параметры запуска — новый процесс, прежний закрыт', async () => {
    fresh();
    const first = await turn('new-4', 'привет');
    const second = await turn('new-4', 'другой моделью', { sessionId: SESSION, model: 'opus' });
    expect(second).toMatch(/^turn 1 pid \d+$/);
    expect(pidIn(second)).not.toBe(pidIn(first));
    expect(registry.livePool.size).toBe(1);
  });

  /**
   * Ревью 28.09 (F-31): метка автономии — часть окружения процесса, и её смена
   * перезапускала живой CLI вместе с фоновыми командами агента — ровно тем, ради
   * чего процесс и живёт между ходами. Пока фон идёт, перезапуск ждёт его конца,
   * а человек узнаёт об этом из ленты; без фона галочка действует сразу.
   */
  describe('галочка автономии и фоновые команды (F-31)', () => {
    let autonomous = true;
    const withResolver = (): void => {
      autonomous = true;
      registry.setAutonomyResolver(() => autonomous);
    };
    const deferredNotice = (chatId: string) =>
      eventsOf(chatId).find(
        (event) => event.kind === 'notice' && event.code === 'autonomyDeferred',
      );

    it('фон идёт — процесс тот же, в ленте сказано, что перезапуск после фона', async () => {
      fresh();
      withResolver();
      const first = await turn('new-a1', 'HOLDBG');
      autonomous = false;
      const second = await turn(SESSION, 'дальше', { sessionId: SESSION });
      expect(pidIn(second)).toBe(pidIn(first));
      expect(deferredNotice(SESSION)).toMatchObject({
        textCode: 'chat-autonomy-deferred-notice',
        textParams: { count: '1' },
      });
    });

    // Отложить можно только метку автономии: смена модели при идущем фоне —
    // тоже новый процесс, иначе ход ушёл бы в CLI с чужими параметрами.
    it('фон идёт, но сменилась модель — новый процесс, без заметки об отсрочке', async () => {
      fresh();
      withResolver();
      const first = await turn('new-a4', 'HOLDBG');
      expect(registry.livePool.backgroundOf(SESSION)).toBe(true);
      const second = await turn(SESSION, 'другой моделью', { sessionId: SESSION, model: 'opus' });
      expect(pidIn(second)).not.toBe(pidIn(first));
      expect(deferredNotice(SESSION)).toBeUndefined();
    });

    it('фона нет — галочка действует сразу: новый процесс, без заметки', async () => {
      fresh();
      withResolver();
      const first = await turn('new-a2', 'привет');
      autonomous = false;
      const second = await turn(SESSION, 'дальше', { sessionId: SESSION });
      expect(pidIn(second)).not.toBe(pidIn(first));
      expect(deferredNotice(SESSION)).toBeUndefined();
    });

    it('фон кончился — следующий ход идёт уже новым процессом', async () => {
      fresh();
      withResolver();
      const first = await turn('new-a3', 'LATEWAKE');
      autonomous = false;
      // Фон ещё идёт: ход в тот же процесс.
      const during = await turn(SESSION, 'пока фон', { sessionId: SESSION });
      expect(pidIn(during)).toBe(pidIn(first));
      // Фон кончился (CLI сам начал ход с итогом) — перезапуск больше ничего не рвёт.
      await waitFor(() => !registry.livePool.backgroundOf(SESSION) && !registry.isRunning(SESSION));
      await waitFor(() => !registry.isRunning(SESSION));
      const after = await turn(SESSION, 'после фона', { sessionId: SESSION });
      expect(pidIn(after)).not.toBe(pidIn(first));
    });
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

  // Решение владельца 30.09: сообщение посреди хода — агенту сразу, а не после
  // конца всей работы (как в самом Claude Code).
  it('сообщение посреди хода уходит в тот же процесс и учитывается этим же ходом', async () => {
    fresh();
    registry.start('new-7', { prompt: 'STEER', cwd, command: COMMAND }, {});
    await waitFor(() => textOf('new-7').startsWith('working'));

    expect(registry.steer('new-7', undefined, 'нашёл баг в форме')).toBe(true);
    await waitFor(() => !registry.isRunning('new-7'));

    expect(textOf('new-7')).toBe('working saw нашёл баг в форме');
    const steered = eventsOf('new-7').filter((event) => event.kind === 'steer');
    expect(steered).toEqual([{ kind: 'steer', text: 'нашёл баг в форме', at: expect.any(String) }]);
    expect(eventsOf('new-7').filter((event) => event.kind === 'done')).toHaveLength(1);
  });

  it('шагов в ходе не осталось — CLI сам начинает следующий ход с сообщением', async () => {
    fresh();
    registry.start('new-8', { prompt: 'STEERLATE', cwd, command: COMMAND }, {});
    await waitFor(() => textOf('new-8').startsWith('working'));

    expect(registry.steer('new-8', undefined, 'добавь ещё пункт')).toBe(true);
    // Ход без хозяина — прогон того же разговора (как пробуждение по фону).
    await waitFor(() => textOf('new-8').includes('next turn got добавь ещё пункт'));
  });

  it('хода нет — сообщение агенту не уходит, отправитель ставит его в очередь', async () => {
    fresh();
    await turn('new-9', 'привет');
    expect(registry.steer('new-9', undefined, 'поздно')).toBe(false);
    expect(registry.steer('unknown', undefined, 'некому')).toBe(false);
  });
});
