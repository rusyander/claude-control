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

/**
 * Промпт контура (Т5.4а): многострочный, с примерами JSON и угловыми скобками
 * грамматики. В командной строке такому тексту делать нечего ни на одной
 * системе — отсюда файл везде, а не только на Windows.
 */
const CONTOUR =
  'Ты работаешь через контур.\n' +
  'Инструмент вызывается блоком:\n' +
  '<tool_call>{"name":"Read","arguments":{"file_path":"a.ts"}}</tool_call>\n' +
  'Больше ничего в этом ходе не пиши.';

interface SpawnCall {
  args: string[];
  /** Содержимое файла читаем в момент запуска: после прогона папки уже нет. */
  fileContents: Record<string, string>;
}

/**
 * Прогон с подменённой системой. `isWindows` в модуле вычисляется на импорте,
 * поэтому платформа подменяется ДО него, а модули сбрасываются.
 */
async function runOn(
  platform: string,
  extra: { appendSystemPrompt?: string; platformSystemPrompt?: string } = {
    appendSystemPrompt: APPENDED,
  },
): Promise<SpawnCall> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });

  const call: SpawnCall = { args: [], fileContents: {} };
  const child = new FakeChild();

  vi.resetModules();
  vi.doMock('node:child_process', () => ({
    spawn: (_command: string, args: string[]) => {
      call.args = args;
      for (const arg of args) {
        // Путь до файла промпта читаем сразу: `start` уберёт папку за собой.
        if (arg.includes('system-prompt')) {
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
    { prompt: 'настоящая задача', cwd: process.cwd(), ...extra },
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

describe('ChatRun: свой системный промпт контура (Т5.4а)', () => {
  for (const platform of ['win32', 'linux']) {
    it(`на ${platform} уходит файлом, дословно, и заменяет промпт CLI`, async () => {
      const call = await runOn(platform, { platformSystemPrompt: CONTOUR });

      const flag = call.args.indexOf('--system-prompt-file');
      expect(flag).toBeGreaterThanOrEqual(0);

      const path = call.args[flag + 1] ?? '';
      // Дословно: ни переводы строк, ни кавычки примера JSON не тронуты.
      expect(call.fileContents[path]).toBe(CONTOUR);
      expect(call.args.some((arg) => arg.includes('"'))).toBe(false);
      // Текст промпта не имеет права оказаться в командной строке ни куском.
      expect(call.args.some((arg) => arg.includes('<tool_call>'))).toBe(false);
    });
  }

  it('пустое значение не добавляет флага вовсе', async () => {
    const call = await runOn('win32', { platformSystemPrompt: '   ' });

    expect(call.args).not.toContain('--system-prompt-file');
    expect(call.args.some((arg) => arg.includes('--system-prompt'))).toBe(false);
  });

  it('живёт рядом с допиской: два разных файла, два разных флага', async () => {
    const call = await runOn('win32', {
      platformSystemPrompt: CONTOUR,
      appendSystemPrompt: APPENDED,
    });

    const own = call.args[call.args.indexOf('--system-prompt-file') + 1] ?? '';
    const appended = call.args[call.args.indexOf('--append-system-prompt-file') + 1] ?? '';
    expect(own).not.toBe(appended);
    expect(call.fileContents[own]).toBe(CONTOUR);
    expect(call.fileContents[appended]).toBe(APPENDED);
  });
});
