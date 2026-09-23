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
    write: (_chunk: string): boolean => true,
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
  /** Что ушло процессу во вход — сам промпт хода. */
  stdin?: string;
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

/**
 * Прогон ребёнка разделения — через НАСТОЯЩИЙ реестр: он решает «это ребёнок»
 * на каждом старте, как и маршрут контура, и отдаёт решение прогону.
 */
async function viaRegistry(
  childKeys: string[],
  chatId: string,
  sessionId?: string,
  brief?: (keys: readonly string[]) => string | undefined,
  prompt = 'задача',
): Promise<SpawnCall> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  const call: SpawnCall = { args: [], fileContents: {}, stdin: '' };
  const child = new FakeChild();
  child.stdin.write = (chunk: string) => {
    call.stdin += chunk;
    return true;
  };

  vi.resetModules();
  vi.doMock('node:child_process', () => ({
    spawn: (_command: string, args: string[]) => {
      call.args = args;
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    },
    spawnSync: () => ({ status: 0 }),
  }));

  try {
    const { ChatRun } = await import('./ChatRunner.ts');
    const { ChatRunRegistry } = await import('./ChatRunRegistry.ts');
    const registry = new ChatRunRegistry(() => new ChatRun());
    registry.setChildResolver((keys) => keys.some((key) => childKeys.includes(key)));
    if (brief) registry.setChildrenBriefResolver(brief);
    registry.start(
      chatId,
      { prompt, cwd: process.cwd(), appendSystemPrompt: 'Инициативы панели.' },
      { projectPath: process.cwd(), ...(sessionId ? { sessionId } : {}) },
    );
    await vi.waitFor(() => expect(call.args.length).toBeGreaterThan(0));
    return call;
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
  }
}

describe('ChatRun: прогон ребёнка разделения', () => {
  it('ребёнку закрыт обмен с другими сессиями и велено спрашивать инструментом (Д16, Д18)', async () => {
    const call = await viaRegistry(['new-1'], 'new-1');

    // Fix-чат и push-чат договорились сами и передали «User decided: stop»,
    // пересказав решение человека без проверки (Д18).
    const deny = call.args.indexOf('--disallowedTools');
    expect(deny).toBeGreaterThanOrEqual(0);
    expect(call.args[deny + 1]?.split(',')).toEqual(['SendMessage', 'ListAgents']);

    const appended = call.args[call.args.indexOf('--append-system-prompt') + 1] ?? '';
    expect(appended.startsWith('Инициативы панели.')).toBe(true);
    // Вопрос текстом из родителя не виден: «твоего вопроса я не видел» (Д16).
    expect(appended).toContain('ТОЛЬКО инструментом AskUserQuestion');
    expect(appended).toContain('С другими сессиями CLI не договаривайся');
  });

  it('ребёнок узнаётся и по ключу сессии, под которым его продолжают', async () => {
    const call = await viaRegistry(['sess-1'], 'new-9', 'sess-1');

    expect(call.args).toContain('--disallowedTools');
  });

  it('обычный разговор ничего этого не получает', async () => {
    const call = await viaRegistry(['other'], 'new-1');

    expect(call.args).not.toContain('--disallowedTools');
    expect(call.args[call.args.indexOf('--append-system-prompt') + 1]).toBe('Инициативы панели.');
  });
});

describe('сводка детей в ходе родителя (Д6)', () => {
  const BRIEF = '<agentdeck-children>\n1. «Шапка» — работает.\n</agentdeck-children>';

  it('ход родителя начинается со сводки, найденной по ключу сессии', async () => {
    const call = await viaRegistry([], 'new-3', 'parent-sess', (keys) =>
      keys.includes('parent-sess') ? BRIEF : undefined,
    );

    // Родитель не знал о детях и на «исправлено?» садился делать работу сам.
    expect(call.stdin).toBe(`${BRIEF}\n\nзадача`);
    // В системную дописку сводка не идёт: та входит в подпись живого процесса.
    expect(call.args[call.args.indexOf('--append-system-prompt') + 1]).toBe('Инициативы панели.');
  });

  it('продолжение со старым промптом получает свежую сводку, а не вторую', async () => {
    const stale = '<agentdeck-children>\n1. «Шапка» — ждёт итога разбора.\n</agentdeck-children>';
    const call = await viaRegistry([], 'parent', undefined, () => BRIEF, `${stale}\n\nзадача`);

    expect(call.stdin).toBe(`${BRIEF}\n\nзадача`);
  });

  it('разговор без детей идёт с промптом как есть', async () => {
    const call = await viaRegistry([], 'solo', undefined, () => undefined);

    expect(call.stdin).toBe('задача');
  });
});
