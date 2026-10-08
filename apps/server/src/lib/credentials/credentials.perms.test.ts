import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';

/**
 * Ф10 — права файла с секретом БЕЗ привязки к POSIX.
 *
 * Рядом уже есть проверки через `statSync` (`credentials.test.ts`), но они идут
 * только на POSIX: на Windows режимы `0o600` попросту не применяются, и тесты
 * пропускаются. Здесь проверяется НАМЕРЕНИЕ — какими флагами и режимами панель
 * зовёт файловые операции. Это работает на любой ОС, поэтому пропусков нет:
 * regression поймается и на Windows-машине разработчика.
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    openSync: vi.fn(actual.openSync),
    mkdirSync: vi.fn(actual.mkdirSync),
  };
});

const fs = await import('node:fs');
const { mkdtempSync, rmSync, existsSync } =
  await vi.importActual<typeof import('node:fs')>('node:fs');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');
const { writeSecretFile } = await import('./credentials.ts');

const openSyncMock = fs.openSync as unknown as Mock;
const mkdirSyncMock = fs.mkdirSync as unknown as Mock;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-creds-perms-'));
  openSyncMock.mockClear();
  mkdirSyncMock.mockClear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('writeSecretFile: намерение по правам (любая ОС)', () => {
  it('файл создаётся флагом wx и режимом 0600 — не «создать, потом chmod»', () => {
    const path = join(dir, 'вложенный', '.credentials.json');

    writeSecretFile(path, '{"apiKey":"sk-ant-api03-x"}');

    const call = openSyncMock.mock.calls.find(([target]) => target === path);
    expect(call).toBeDefined();
    // 'wx' — создать и упасть, если файл уже есть: на его место нельзя подсунуть
    // ссылку на чужой путь между удалением и созданием.
    expect(call![1]).toBe('wx');
    expect(call![2]).toBe(0o600);
    expect(existsSync(path)).toBe(true);
  });

  it('каталог секрета создаётся с режимом 0700', () => {
    const path = join(dir, 'секреты', '.credentials.json');

    writeSecretFile(path, '{"apiKey":"sk-ant-api03-x"}');

    const call = mkdirSyncMock.mock.calls.find(([target]) => target === join(dir, 'секреты'));
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({ recursive: true, mode: 0o700 });
  });

  it('перезапись сначала удаляет файл — иначе унаследовались бы прежние права', () => {
    const path = join(dir, '.credentials.json');
    writeSecretFile(path, '{"apiKey":"первый"}');
    openSyncMock.mockClear();

    writeSecretFile(path, '{"apiKey":"второй"}');

    // Повторное создание тем же 'wx' возможно, только если старый файл удалён.
    const call = openSyncMock.mock.calls.find(([target]) => target === path);
    expect(call![1]).toBe('wx');
    expect(call![2]).toBe(0o600);
  });
});
