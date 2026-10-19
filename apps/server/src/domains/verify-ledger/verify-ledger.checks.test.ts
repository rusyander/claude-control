import { createRequire } from 'node:module';
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
