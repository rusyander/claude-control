import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

/**
 * Ф10 — детект CLI на трёх ОС без живых macOS/Linux.
 *
 * `spawnSync` подменён: проверяется ровно то, что от детекта требуется —
 * какой искатель зовётся на какой ОС (`where` или обход PATH), что МНОГОСТРОЧНЫЙ вывод
 * `where` (одна команда в нескольких каталогах PATH) ничего не ломает, что вывод
 * вообще не разбирается, и что ошибка/таймаут никогда не выходят наружу.
 */
const spawnSyncMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));
/** Обход PATH на macOS/Linux — свой модуль со своими тестами; здесь важно, что зовётся он. */
const posixMatches = vi.fn((_command: string): string[] => []);
vi.mock('../../lib/path-lookup.mjs', () => ({
  posixPathMatches: (command: string) => posixMatches(command),
}));

const { detectCliOnPath, findCliOnPath, detectProvider, resetCliLookupCache } =
  await import('./detect.ts');
const { getProvider } = await import('../registry.ts');

function withPlatform(platform: NodeJS.Platform): void {
  vi.stubGlobal('process', { ...process, platform });
}

beforeEach(() => {
  spawnSyncMock.mockReset();
  // Кеш поиска живёт на процесс — между кейсами его надо сбрасывать.
  resetCliLookupCache();
});
// Сбрасываем мок и ПОСЛЕ теста: с оставшейся «бросающей» реализацией собственная
// уборка vitest сама наткнулась бы на неё и уронила тест.
afterEach(() => {
  spawnSyncMock.mockReset();
  vi.unstubAllGlobals();
});

describe('detectCliOnPath: искатель по платформе', () => {
  it('win32 зовёт where с самим именем команды; darwin/linux обходят PATH без процесса', () => {
    spawnSyncMock.mockReturnValue({ status: 0 });

    withPlatform('win32');
    expect(detectCliOnPath('codex.cmd')).toBe(true);
    expect(spawnSyncMock.mock.calls[0]![0]).toBe('where');
    expect(spawnSyncMock.mock.calls[0]![1]).toEqual(['codex.cmd']);

    for (const platform of ['darwin', 'linux'] as const) {
      spawnSyncMock.mockClear();
      // Одна команда на двух платформах подряд — только в тесте; кеш ответа сбрасываем.
      resetCliLookupCache();
      withPlatform(platform);
      posixMatches.mockReturnValueOnce(['/usr/local/bin/codex']);
      expect(detectCliOnPath('codex')).toBe(true);
      expect(posixMatches).toHaveBeenLastCalledWith('codex');
      // Внешнего `which` нет в части дистрибутивов — процесс не запускается вовсе.
      expect(spawnSyncMock).not.toHaveBeenCalled();
      resetCliLookupCache();
      posixMatches.mockReturnValueOnce([]);
      expect(detectCliOnPath('codex')).toBe(false);
    }
  });

  it('вывод не разбирается: НЕСКОЛЬКО строк от `where` — по-прежнему «найдено»', () => {
    withPlatform('win32');
    // Реальный `where claude.cmd` печатает по строке на каждый каталог PATH.
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd\r\nC:\\tools\\claude.cmd\r\n',
    });
    expect(detectCliOnPath('claude.cmd')).toBe(true);
    // stdio: 'ignore' — вывод даже не запрашивается.
    expect(spawnSyncMock.mock.calls[0]![2]).toMatchObject({ stdio: 'ignore' });
  });

  it('ненулевой код, брошенное исключение и таймаут → «не найдено», без падения', () => {
    withPlatform('win32');
    spawnSyncMock.mockReturnValue({ status: 1 });
    expect(detectCliOnPath('нет-такого')).toBe(false);

    spawnSyncMock.mockReturnValue({ status: null, error: new Error('ETIMEDOUT') });
    expect(detectCliOnPath('зависший')).toBe(false);

    // Брошенное исключение самого spawn (нет прав, политика) тоже гасится.
    spawnSyncMock.mockImplementation(() => {
      throw new Error('spawn запрещён');
    });
    expect(detectCliOnPath('любой')).toBe(false);
  });
});

describe('findCliOnPath: перебор кандидатов', () => {
  it('возвращает ПЕРВОЕ найденное имя, иначе undefined', () => {
    const only = (name: string) => (command: string) => command === name;
    expect(findCliOnPath(['codex.cmd', 'codex'], only('codex.cmd'))).toBe('codex.cmd');
    // .cmd нет (поставлен нативный .exe) — находим голое имя.
    expect(findCliOnPath(['codex.cmd', 'codex'], only('codex'))).toBe('codex');
    expect(findCliOnPath(['codex.cmd', 'codex'], () => false)).toBeUndefined();
  });
});

describe('detectProvider на Windows: npm-обёртка и нативный .exe', () => {
  it('стоит только codex.exe (`where codex` находит, `where codex.cmd` — нет) → установлен', () => {
    withPlatform('win32');
    const detection = detectProvider(getProvider('codex'), undefined, {
      detectCli: (command) => command === 'codex',
      exists: () => false,
    });

    expect(detection.cliInstalled).toBe(true);
    // Показываем и запускаем то имя, которое реально нашлось.
    expect(detection.cliCommand).toBe('codex');
  });

  it('стоит npm-обёртка → используется .cmd (прежнее поведение claude)', () => {
    withPlatform('win32');
    const detection = detectProvider(getProvider('claude'), undefined, {
      detectCli: (command) => command === 'claude.cmd',
      exists: () => true,
    });

    expect(detection.cliInstalled).toBe(true);
    expect(detection.cliCommand).toBe('claude.cmd');
  });

  it('не найдено ничего → cliInstalled=false и имя по умолчанию для ОС', () => {
    withPlatform('darwin');
    const detection = detectProvider(getProvider('gemini'), undefined, {
      detectCli: () => false,
      exists: () => false,
    });

    expect(detection.cliInstalled).toBe(false);
    expect(detection.cliCommand).toBe('gemini');
  });
});
