import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { availableParallelism } from 'node:os';

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

/**
 * Находка 46 живого прогона: параллельные группы разделения гоняли vitest каждая
 * на все ядра — около сорока рабочих процессов разом. Ребёнку разделения панель
 * ставит потолок в окружение CLI; обычному чату — нет.
 */
describe('ChatRun.start: потолок рабочих процессов vitest', () => {
  const KEYS = ['VITEST_MAX_WORKERS', 'VITEST_MAX_THREADS', 'VITEST_MAX_FORKS'] as const;

  /** Окружение, с которым CLI реально запущен. */
  async function spawnedEnv(
    extra: { child?: boolean; env?: Record<string, string> } = {},
  ): Promise<NodeJS.ProcessEnv> {
    const run = new ChatRun();
    const finished = run.start(
      { prompt: 'привет', cwd: process.cwd(), command: 'fake-cli', ...extra },
      () => undefined,
    );
    process.nextTick(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    await finished;
    const call = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    return call[2].env;
  }

  const saved: Partial<Record<(typeof KEYS)[number], string>> = {};
  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('ребёнку разделения — четверть ядер, во всех трёх именах', async () => {
    const env = await spawnedEnv({ child: true });
    const expected = String(Math.max(1, Math.floor(availableParallelism() / 4)));
    for (const key of KEYS) expect(env[key]).toBe(expected);
  });

  it('обычный чат потолка не получает', async () => {
    const env = await spawnedEnv();
    for (const key of KEYS) expect(env[key]).toBeUndefined();
  });

  it('потолок из окружения панели сильнее нашего', async () => {
    process.env.VITEST_MAX_WORKERS = '7';
    const env = await spawnedEnv({ child: true });
    expect(env.VITEST_MAX_WORKERS).toBe('7');
    expect(env.VITEST_MAX_THREADS).toBeUndefined();
  });

  it('окружение прогона сильнее нашего', async () => {
    const env = await spawnedEnv({ child: true, env: { VITEST_MAX_WORKERS: '3' } });
    expect(env.VITEST_MAX_WORKERS).toBe('3');
  });
});

/**
 * Аудит 25.09, L280: заглушка CLI (`model: <synthetic>`, «No response
 * requested.») в живом потоке давала шаг расхода с нулями — окно в шапке
 * падало в ноль, — а её текст ложился в ленту и хвост ответа.
 */
describe('ChatRun.start: заглушка CLI в потоке', () => {
  it('ни расхода, ни текста от <synthetic>; настоящий ответ проходит', async () => {
    const events: { kind: string; message?: string; text?: string; model?: string }[] = [];
    const finished = runWithDeadline(events, process.cwd());
    const zero = { input_tokens: 0, output_tokens: 0 };
    const lines = [
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'm0', model: '<synthetic>', role: 'assistant', content: [], usage: zero },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'No response requested.' },
        },
      },
      { type: 'stream_event', event: { type: 'message_delta', usage: zero } },
      { type: 'stream_event', event: { type: 'message_stop' } },
      {
        type: 'assistant',
        message: {
          id: 'm0',
          model: '<synthetic>',
          role: 'assistant',
          content: [{ type: 'text', text: 'No response requested.' }],
          usage: zero,
        },
      },
      // Настоящий ответ: текст — дельтами, как у живого CLI.
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'm1', model: 'claude-opus-5', role: 'assistant', content: [] },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Настоящий ответ' },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'message_delta', usage: { input_tokens: 120, output_tokens: 7 } },
      },
      { type: 'stream_event', event: { type: 'message_stop' } },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          model: 'claude-opus-5',
          role: 'assistant',
          content: [{ type: 'text', text: 'Настоящий ответ' }],
          usage: { input_tokens: 120, output_tokens: 7 },
        },
      },
      { type: 'result', subtype: 'success', is_error: false, result: 'Настоящий ответ' },
    ];

    process.nextTick(() => {
      for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });

    expect(await finished).toBe(true);
    const texts = events.filter((event) => event.kind === 'text').map((event) => event.text);
    expect(texts.join('')).not.toContain('No response requested');
    expect(texts.join('')).toContain('Настоящий ответ');
    const models = events.filter((event) => event.kind === 'usage').map((event) => event.model);
    expect(models).not.toContain('<synthetic>');
    expect(models).toContain('claude-opus-5');
  });
});
