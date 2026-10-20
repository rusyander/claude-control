import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Распознавание проверки (`tools/verify-ledger/checks.cjs`) — чистая логика по
 * argv, без git и без процессов.
 */
const DIR = resolve(__dirname, '../../../../../tools/verify-ledger');
const load = createRequire(__filename);
const { recognize } = load(join(DIR, 'checks.cjs')) as {
  recognize: (argv: string[], cwd: string) => { id: string; noSkip: string | null } | null;
};

const cwd = resolve(__dirname);
const vitest = join(cwd, 'node_modules/vitest/vitest.mjs');
const noSkipOf = (...args: string[]) => recognize(['node', vitest, ...args], cwd)?.noSkip;

describe('verify-ledger checks: покрытие и повтор', () => {
  // 19.10: блок Tests (`tools/qa/junit-run.mjs`) передаёт `--coverage.enabled=false` на
  // каждом прогоне, а `/^--coverage/` считал и его «пишущим покрытие» — 115 прогонов за
  // день записаны промахом `vitest --coverage.enabled=false` и ни один не повторён.
  it('выключенное покрытие не мешает повтору', () => {
    for (const flags of [
      ['--coverage.enabled=false'],
      ['--coverage.enabled', 'false'],
      ['--coverage=false'],
      ['--no-coverage'],
      ['--coverage.enabled=false', '--coverage.reporter=json'],
      ['--coverage', '--coverage.enabled=false'],
    ]) {
      expect(noSkipOf('run', ...flags), flags.join(' ')).toBeNull();
    }
  });

  it('включённое покрытие — никогда не повтор', () => {
    for (const flags of [
      ['--coverage'],
      ['--coverage=true'],
      ['--coverage.enabled'],
      ['--coverage.enabled=true'],
      ['--coverage.enabled', 'true'],
      ['--coverage.enabled=false', '--coverage'],
      ['--no-coverage', '--coverage.enabled=true'],
      // Ключ покрытия без явного выключения: конфиг может включать покрытие сам.
      ['--coverage.reporter=json'],
    ]) {
      expect(noSkipOf('run', ...flags), flags.join(' ')).toMatch(/^vitest --coverage/);
    }
    expect(noSkipOf('run', '-u')).toBe('vitest -u');
  });
});

/** Символьная ссылка файла; Windows без режима разработчика её не даёт — тест молчит. */
function canLink(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'cc-ledger-link-'));
  try {
    writeFileSync(join(dir, 'a'), '');
    symlinkSync(join(dir, 'a'), join(dir, 'b'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// npm, yarn и bun на Linux/macOS: `.bin/vitest` — ссылка, argv[1] остаётся её путём.
describe.skipIf(!canLink())('verify-ledger checks: запуск через node_modules/.bin', () => {
  it('ссылка .bin узнаётся по настоящему файлу пакета', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ledger-bin-'));
    try {
      mkdirSync(join(dir, 'node_modules/vitest'), { recursive: true });
      mkdirSync(join(dir, 'node_modules/.bin'));
      writeFileSync(join(dir, 'node_modules/vitest/vitest.mjs'), '');
      symlinkSync('../vitest/vitest.mjs', join(dir, 'node_modules/.bin/vitest'));
      const hit = recognize(['node', join(dir, 'node_modules/.bin/vitest'), 'run'], dir) as {
        id: string;
        script: string;
      } | null;
      expect(hit?.id).toBe('vitest');
      expect(hit?.script).toMatch(/node_modules\/vitest\/vitest\.mjs$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
