import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/**
 * Падение запуска CLI не должно уносить сервер.
 *
 * Провал `spawn` (выбран провайдер, чей CLI не установлен → ENOENT) и EPIPE на
 * stdin приходят СОБЫТИЯМИ `error`; без слушателя Node роняет весь процесс
 * Fastify, и вместе с чатом умирают все остальные прогоны и вкладки. Живой CLI
 * тут не поднять, поэтому `spawn` подменён: фальшивый процесс запоминает
 * `error` без слушателя вместо того, чтобы убивать прогон тестов, — так «сервер
 * бы умер» становится обычным утверждением.
 */

/** Поток, который вместо смерти процесса записывает необработанный `error`. */
class FakeStream extends EventEmitter {
  readonly unhandled: string[] = [];
  written = '';

  write(chunk: string): boolean {
    this.written += chunk;
    return true;
  }

  end(): void {}

  raise(code: string): void {
    if (this.listenerCount('error') === 0) {
      this.unhandled.push(code);
      return;
    }
    this.emit('error', Object.assign(new Error(`write ${code}`), { code }));
  }
}

class FakeChild extends EventEmitter {
  readonly stdin = new FakeStream();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly unhandled: string[] = [];
  pid?: number;

  raise(code: string): void {
    if (this.listenerCount('error') === 0) {
      this.unhandled.push(code);
      return;
    }
    this.emit('error', Object.assign(new Error(`spawn ${code}`), { code }));
  }
}

let child: FakeChild;
const spawnMock = vi.fn(() => child);

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...(args as [])),
  // process-tree берёт из того же модуля — без неё падает импорт.
  spawnSync: () => ({ status: 0 }),
}));

const { ChatRun } = await import('./ChatRunner.ts');

beforeEach(() => {
  child = new FakeChild();
  spawnMock.mockClear();
});

/** Прогон с потолком по времени: зависший `start` — тоже провал. */
async function runWithDeadline(
  events: { kind: string; message?: string }[],
  cwd: string,
): Promise<boolean> {
  const run = new ChatRun();
  const started = run
    .start({ prompt: 'привет', cwd, command: 'missing-cli' }, (event) => events.push(event))
    .then(() => true);
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000));
  return Promise.race([started, timeout]);
}

describe('ChatRun.start: сбой запуска CLI', () => {
  it('ENOENT не роняет сервер, а приходит в чат ошибкой', async () => {
    const events: { kind: string; message?: string }[] = [];
    const finished = runWithDeadline(events, process.cwd());

    // Как настоящий Node: событие уходит сразу после spawn — до того, как
    // разбор потока успеет что-то подписать.
    process.nextTick(() => {
      child.stdout.end();
      child.stderr.end();
      child.raise('ENOENT');
      child.emit('close', -4058);
    });

    expect(await finished).toBe(true);
    // Главное: слушатель был — иначе Node убил бы процесс сервера.
    expect(child.unhandled).toEqual([]);
    const error = events.find((event) => event.kind === 'error');
    expect(error?.message).toContain('missing-cli');
    expect(error?.message).toContain('ENOENT');
  });

  it('EPIPE на stdin гасится, а провал прогона всё равно виден', async () => {
    const events: { kind: string; message?: string }[] = [];
    const finished = runWithDeadline(events, process.cwd());

    // CLI закрылся раньше, чем дописан промпт: запись бьёт в мёртвый канал.
    child.stdin.raise('EPIPE');
    process.nextTick(() => {
      child.stderr.write('Invalid API key');
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 1);
    });

    expect(await finished).toBe(true);
    expect(child.stdin.unhandled).toEqual([]);
    expect(events.find((event) => event.kind === 'error')?.message).toContain('Invalid API key');
  });

  /**
   * Живой прогон dev 14.09.2026 (claude 2.1.263): отказ контура CLI называет
   * потоком, выходит с кодом 1, а в stderr — только служебная строка про модель
   * не из каталога Anthropic. Чат показывал её вместо причины.
   */
  it('причина из потока не затирается служебной строкой stderr', async () => {
    const events: { kind: string; message?: string }[] = [];
    const finished = runWithDeadline(events, process.cwd());
    const reason = 'API Error: 400 Проверки контента контура остановили ответ: ТЕСТ · маркер';

    process.nextTick(() => {
      child.stdout.write(
        `${JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: reason })}\n`,
      );
      child.stderr.write(
        '[claude-code:unrecognized_model] {"model":"Qwen/Qwen3.8-27B-FP8","query_source":"sdk"}',
      );
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 1);
    });

    expect(await finished).toBe(true);
    const errors = events.filter((event) => event.kind === 'error');
    expect(errors.map((event) => event.message)).toEqual([reason]);
  });

  it('pid процесса известен сразу после start — реестр пишет его в журнал на диске', async () => {
    child.pid = 4242;
    const run = new ChatRun();
    const finished = run.start(
      { prompt: 'привет', cwd: process.cwd(), command: 'fake-cli' },
      () => undefined,
    );
    // Синхронно, до первого await внутри start: spawn идёт раньше разбора потока.
    expect(run.pid).toBe(4242);

    process.nextTick(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    await finished;
  });
});

/**
 * Имя модели, не прошедшее грамматику аргументов, до 18.09.2026 уезжало МОЛЧА:
 * шапка чата показывала выбранное имя, `--model` в командную строку не
 * попадал, и прогон шёл моделью, которую CLI выбирает сам. Узнать об этом было
 * неоткуда — ни строки в ленте, ни следа (ревью Т0→Т13, R3 MINOR-2).
 */
describe('ChatRun.start: имя модели, отброшенное грамматикой', () => {
  /** Прогон до закрытия процесса, с записью всех событий. */
  async function runWith(model: string): Promise<{ kind: string; code?: string; text?: string }[]> {
    const events: { kind: string; code?: string; text?: string }[] = [];
    const run = new ChatRun();
    const finished = run.start(
      { prompt: 'привет', cwd: process.cwd(), command: 'fake-cli', model },
      (event) => events.push(event as { kind: string }),
    );
    process.nextTick(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    await finished;
    return events;
  }

  it('отброшенное имя названо лентой, а в командную строку не уезжает', async () => {
    // Пробел — ровно то, что оболочка Windows разберёт как второй аргумент.
    const events = await runWith('qwen 2.5:7b');
    const notice = events.find((event) => event.kind === 'notice');
    expect(notice?.code).toBe('modelDropped');
    expect(notice?.text).toContain('qwen 2.5:7b');
    const args = (spawnMock.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args).not.toContain('--model');
  });

  it('имя из каталога контура проходит и заметки не рождает', async () => {
    const events = await runWith('qwen2.5:7b');
    expect(events.find((event) => event.kind === 'notice')).toBeUndefined();
    const args = (spawnMock.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args).toContain('--model');
    expect(args).toContain('qwen2.5:7b');
  });
});
