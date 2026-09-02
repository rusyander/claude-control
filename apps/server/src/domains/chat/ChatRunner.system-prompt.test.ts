import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Дописка к системному промпту не имеет права ехать через командную строку
 * Windows.
 *
 * Замерено настоящим запуском 2 сентября 2026 (claude 2.1.177): в тексте
 * инициатив есть примеры JSON с кавычками, а цепочка `cmd.exe` → `claude.cmd` →
 * `claude.exe` разбирает их по-разному. Системная строка обрывалась, а её
 * обломок становился позиционным аргументом, то есть ПРОМПТОМ: агент получал
 * `"контекст\nВот три независимые задачи…"` вместо отправленного человеком
 * текста — и так на каждом сообщении.
 *
 * Отсюда два утверждения, и второе важнее первого: на Windows значение уходит
 * файлом, и НИ ОДИН аргумент не содержит кавычки, сколько бы их ни было в самой
 * дописке.
 */

class FakeChild extends EventEmitter {
  readonly stdin = Object.assign(new EventEmitter(), {
    write: () => true,
    end: () => undefined,
  });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

/** Текст с теми самыми кавычками, на которых всё и разваливалось. */
const APPENDED =
  'Панель показывает предложения карточками. Выведи блок с JSON вида ' +
  '{"done":"что закрыто","next":"чем продолжить","checkpoint":".agent/PROGRESS.md"} и остановись.';

interface SpawnCall {
  args: string[];
  /** Содержимое файла читаем в момент запуска: после прогона папки уже нет. */
  fileContents: Record<string, string>;
}

/**
 * Прогон с подменённой системой. `isWindows` в модуле вычисляется на импорте,
 * поэтому платформа подменяется ДО него, а модули сбрасываются.
 */
async function runOn(platform: string): Promise<SpawnCall> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });

  const call: SpawnCall = { args: [], fileContents: {} };
  const child = new FakeChild();

  vi.resetModules();
  vi.doMock('node:child_process', () => ({
    spawn: (_command: string, args: string[]) => {
      call.args = args;
      for (const arg of args) {
        // Путь до файла дописки читаем сразу: `start` уберёт папку за собой.
        if (arg.includes('append-system-prompt')) {
          try {
            call.fileContents[arg] = readFileSync(arg.replace(/^"|"$/g, ''), 'utf8');
          } catch {
            // Не путь, а само значение — читать нечего.
          }
        }
      }
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    },
    spawnSync: () => ({ status: 0 }),
  }));

  const { ChatRun } = await import('./ChatRunner.ts');
  await new ChatRun().start(
    { prompt: 'настоящая задача', cwd: process.cwd(), appendSystemPrompt: APPENDED },
    () => undefined,
  );

  if (original) Object.defineProperty(process, 'platform', original);
  return call;
}

afterEach(() => {
  vi.doUnmock('node:child_process');
  vi.resetModules();
});

describe('ChatRun: дописка к системному промпту', () => {
  it('на Windows уходит файлом, и в командной строке нет ни одной кавычки', async () => {
    const call = await runOn('win32');

    const flag = call.args.findIndex((arg) => arg.includes('--append-system-prompt-file'));
    expect(flag).toBeGreaterThanOrEqual(0);

    const path = call.args[flag + 1] ?? '';
    expect(call.fileContents[path]).toBe(APPENDED);

    // То самое, из-за чего промпт подменялся обломком: кавычка в аргументе.
    expect(call.args.some((arg) => arg.includes('"'))).toBe(false);
    expect(call.args).not.toContain('--append-system-prompt');
  });

  it('на остальных системах остаётся обычным аргументом', async () => {
    const call = await runOn('linux');

    const flag = call.args.indexOf('--append-system-prompt');
    expect(flag).toBeGreaterThanOrEqual(0);
    expect(call.args[flag + 1]).toBe(APPENDED);
    expect(call.args.some((arg) => arg.includes('--append-system-prompt-file'))).toBe(false);
  });
});
