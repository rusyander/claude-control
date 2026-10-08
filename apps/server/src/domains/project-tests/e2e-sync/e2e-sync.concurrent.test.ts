import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncE2eFolder } from './e2e-sync.ts';
import { readGroups } from '../store/store.ts';

/**
 * F-321. Сверка перечитывает группу перед записью, но правленый кейс брала
 * целиком из ПЕРВОГО чтения: статус, записанный агентом в окне между разбором и
 * записью, пропадал. Окно подменено одним: второй писатель (агент, другой
 * процесс) правит файл группы ровно в момент перечитывания.
 */
const race = vi.hoisted(() => ({ write: undefined as (() => void) | undefined }));
vi.mock('../store/store.ts', async (original) => {
  const real = await original<typeof import('../store/store.ts')>();
  return {
    ...real,
    loadForWrite: (root: string, id: string) => {
      race.write?.();
      race.write = undefined;
      return real.loadForWrite(root, id);
    },
  };
});

const SPEC = (title: string) =>
  `import { test } from '@playwright/test';\ntest('[auth-001] ${title}', async () => {});\n`;

describe('сверка e2e и параллельная запись агента', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-e2e-sync-race-'));
    mkdirSync(join(root, 'e2e'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('статус, записанный агентом между разбором и записью, остаётся', () => {
    const now = '2026-09-27T10:00:00.000Z';
    writeFileSync(join(root, 'e2e', 'auth.spec.ts'), SPEC('вход'));
    syncE2eFolder(root, now, { dir: 'e2e' });

    // Тест переименован — сверка перепишет testName кейса.
    writeFileSync(join(root, 'e2e', 'auth.spec.ts'), SPEC('вход по паролю'));
    const file = join(root, '.agent', 'tests', 'auth.tests.json');
    race.write = () => {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      data.cases[0].status = 'failed';
      data.cases[0].note = 'агент: кнопка не нажимается';
      writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    };
    const second = syncE2eFolder(root, '2026-09-27T11:00:00.000Z', { dir: 'e2e' });
    expect(second.linked).toBe(1);
    const item = readGroups(root)[0]?.cases[0];
    expect(item?.automation?.testName).toContain('вход по паролю');
    expect(item).toMatchObject({ status: 'failed', note: 'агент: кнопка не нажимается' });
  });
});
