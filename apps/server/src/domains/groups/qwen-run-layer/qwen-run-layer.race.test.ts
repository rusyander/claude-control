import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * @covers qwen-run-layer.ts — `writeQwenSettingsLayer` (тот же приём у `writeQwenLayer`
 *   и писателей `system-note.ts`)
 * @scenario два прогона с одинаковыми настройками пишут один каталог по содержимому.
 *   Проигравший проверил «файла нет» ДО того, как победитель переименовал свой
 *   черновик, — и не вправе сносить уже готовый каталог: только что запущенный Qwen
 *   в этот миг читает из него файл настроек (группа, рычаги, строка о каталоге).
 */

/** Победитель «успевает» между проверкой проигравшего и его переименованием. */
const race: { winner?: (stagingFile: string) => void } = {};

vi.mock('../../../lib/safe-io/safe-io.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/safe-io/safe-io.ts')>();
  return {
    ...real,
    writeJsonFile: (...args: Parameters<typeof real.writeJsonFile>) => {
      const out = real.writeJsonFile(...args);
      race.winner?.(args[0]);
      return out;
    },
  };
});

const { writeQwenSettingsLayer } = await import('./qwen-run-layer.ts');

describe('qwen-run-layer same-digest race', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-qwen-race-'));
  });
  afterEach(() => {
    race.winner = undefined;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('a losing writer never removes the finished layer of the same digest', () => {
    const digest = 'same-digest';
    const finished = join(root, digest);
    race.winner = (stagingFile) => {
      // Черновик проигравшего записан; победитель как раз закончил свой каталог.
      if (!basename(dirname(stagingFile)).startsWith(`.${digest}-`)) return;
      mkdirSync(finished, { recursive: true });
      writeFileSync(join(finished, 'system-settings.json'), '{"winner":true}');
      // Метка «этот каталог держит запущенный CLI»: снос каталога её уносит.
      writeFileSync(join(finished, 'in-use'), '');
    };
    const out = writeQwenSettingsLayer(root, digest, { loser: true });
    const file = out.QWEN_CODE_SYSTEM_SETTINGS_PATH ?? '';
    expect(file).toBe(join(finished, 'system-settings.json'));
    // Каталог победителя цел: его файл, его метка; черновик проигравшего убран.
    expect(existsSync(join(finished, 'in-use'))).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ winner: true });
    expect(readdirSync(root)).toEqual([digest]);
  });

  it('a half-written dir without the settings file is still replaced', () => {
    const digest = 'crashed';
    // Сбой посреди сборки: каталог есть, файла настроек нет.
    mkdirSync(join(root, digest, 'junk'), { recursive: true });
    const out = writeQwenSettingsLayer(root, digest, { fresh: true });
    expect(JSON.parse(readFileSync(out.QWEN_CODE_SYSTEM_SETTINGS_PATH ?? '', 'utf8'))).toEqual({
      fresh: true,
    });
    expect(existsSync(join(root, digest, 'junk'))).toBe(false);
  });
});
