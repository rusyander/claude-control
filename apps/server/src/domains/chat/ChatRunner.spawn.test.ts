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
});
