import { describe, expect, it } from 'vitest';
import { isWholeSuite } from './vitest.whole-suite.ts';

/** Ревью m4: значение флага отдельным аргументом выключало покрытие прогона всего набора. */
describe('vitest whole-suite detection', () => {
  it('m4 space-separated flag values are not filters: coverage stays on', () => {
    for (const args of [
      ['run'],
      ['run', '--reporter', 'verbose'],
      ['run', '--shard', '1/2'],
      ['run', '--project', 'core'],
      ['run', '--coverage.reportsDirectory', 'coverage'],
      ['run', '--coverage.reportsDirectory=coverage', '--reporter=dot'],
      ['run', '--silent', 'passed-only'],
      ['--config', 'vitest.config.ts', 'run'],
    ]) {
      expect({ args, whole: isWholeSuite(args) }).toEqual({ args, whole: true });
    }
  });

  it('F-80 value flags of vitest 4 our list missed are not filters: coverage stays on', () => {
    for (const args of [
      ['run', '--diff', 'd.json'],
      ['run', '--configLoader', 'runner'],
      ['run', '--api', '51204'],
      ['run', '--inspect-brk', '9229'],
      ['run', '--inspect', '9229'],
      ['run', '--retry', '2'],
    ]) {
      expect({ args, whole: isWholeSuite(args) }).toEqual({ args, whole: true });
    }
  });

  it('F-80 --changed and related narrow the set: coverage off', () => {
    for (const args of [
      ['run', '--changed'],
      ['run', '--changed', 'HEAD~1'],
      ['related', 'src/journal/lease.ts'],
      ['run', '--related', 'src/journal/lease.ts'],
      ['run', '--retry', '2', 'src/journal/lease.test.ts'],
    ]) {
      expect({ args, whole: isWholeSuite(args) }).toEqual({ args, whole: false });
    }
  });

  it('m4 a file filter or a name filter is a partial run: coverage off', () => {
    for (const args of [
      ['run', 'src/journal'],
      ['run', '--reporter', 'verbose', 'src/journal/lease.test.ts'],
      ['run', '-t', 'lease'],
      ['run', '--testNamePattern=lease'],
      ['run', '--silent', 'src/api'],
      ['src/api'],
    ]) {
      expect({ args, whole: isWholeSuite(args) }).toEqual({ args, whole: false });
    }
  });
});
