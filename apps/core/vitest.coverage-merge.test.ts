import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const merge = fileURLToPath(new URL('../../tools/core-coverage-merge.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
/**
 * Слияние — оркестратор хоста (сам запускает Linux-прогон); копия в контейнере не несёт ни
 * `tools/`, ни корневых зависимостей (`istanbul-lib-coverage`). Логика порога от ОС не зависит —
 * её проверяет прогон хоста.
 */
const inLinuxCopy = process.env.AGENTDECK_CORE_LINUX_COPY === '1';

/** Карта istanbul из одного файла с одним оператором; `hits` — сколько раз он исполнен. */
function oneFileMap(path: string, hits: number) {
  return {
    [path]: {
      path,
      statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 9 } } },
      fnMap: {},
      branchMap: {},
      s: { 0: hits },
      f: {},
      b: {},
    },
  };
}

function writeMap(dir: string, name: string, map: object): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(map));
  return file;
}

function runMerge(args: string[]) {
  return spawnSync(process.execPath, [merge, ...args], { encoding: 'utf8' });
}

/** Ревью core-s2 F-80: слитый порог покрытия не должен зеленеть на испорченных порогах и нечислах. */
describe('core coverage merge gate', () => {
  it.skipIf(inLinuxCopy)(
    'F-80 the merged threshold selftest: bad thresholds exit 2, a non-number on either side is a shortfall',
    () => {
      const run = runMerge(['--selftest']);
      expect(run.stdout).toMatch(/\[core-coverage\] selftest: (\d+)\/\1\b/);
      expect(run.status).toBe(0);
    },
  );

  /**
   * Q1 (владелец 28.10): CI сливает три ОС. Каждый раннер приводит карту `--normalize` (корни у
   * раннеров разные), задание слияния читает приведённые карты `--map метка=путь`.
   */
  describe('three-OS merge for CI', () => {
    const file = 'apps/core/src/a.ts';
    const absolute = join(repoRoot, file);

    it.skipIf(inLinuxCopy)(
      'a runner map normalized on its own root merges with the other two and passes when only the third OS covered the line',
      () => {
        const dir = mkdtempSync(join(tmpdir(), 'cov-merge-'));
        const raw = writeMap(dir, 'raw-windows.json', oneFileMap(absolute, 0));
        const normalized = join(dir, 'windows.json');
        const normalize = runMerge(['--normalize', raw, normalized]);
        expect(normalize.status).toBe(0);
        // Ключ и путь — от корня: на раннере слияния абсолютный путь другого раннера был бы чужим.
        const written = JSON.parse(readFileSync(normalized, 'utf8')) as Record<
          string,
          { path: string }
        >;
        expect(Object.keys(written)).toEqual([file]);
        expect(written[file]?.path).toBe(file);
        const linux = writeMap(dir, 'linux.json', oneFileMap(`/home/node/w/${file}`, 0));
        const macos = writeMap(dir, 'macos.json', oneFileMap(file, 1));
        const run = runMerge([
          '--map',
          `windows=${normalized}`,
          '--map',
          `linux=${linux}`,
          '--map',
          `macos=${macos}`,
        ]);
        expect(run.stdout).toMatch(/^windows .*statements 0\.00/m);
        expect(run.stdout).toMatch(/^macos .*statements 100\.00/m);
        expect(run.stdout).toMatch(/^MERGED .*statements 100\.00/m);
        expect(run.stdout).toContain('merged gate: PASS');
        expect(run.status).toBe(0);
      },
    );

    it.skipIf(inLinuxCopy)('no OS covered the line: the merged gate fails with exit 1', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cov-merge-'));
      const maps = ['windows', 'linux', 'macos'].map(
        (label) => `${label}=${writeMap(dir, `${label}.json`, oneFileMap(file, 0))}`,
      );
      const run = runMerge(maps.flatMap((map) => ['--map', map]));
      expect(run.stdout).toContain('merged gate: FAIL');
      expect(run.status).toBe(1);
    });

    it.skipIf(inLinuxCopy)('maps covering different files are refused with exit 2', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cov-merge-'));
      const one = writeMap(dir, 'one.json', oneFileMap(file, 1));
      const other = writeMap(dir, 'other.json', oneFileMap('apps/core/src/b.ts', 1));
      const run = runMerge(['--map', `windows=${one}`, '--map', `linux=${other}`]);
      expect(run.stderr).toContain('maps cover different files');
      expect(run.status).toBe(2);
    });

    it.skipIf(inLinuxCopy)(
      'a map with paths outside the repo is refused by --normalize with exit 2',
      () => {
        const dir = mkdtempSync(join(tmpdir(), 'cov-merge-'));
        const raw = writeMap(dir, 'raw.json', oneFileMap('/elsewhere/apps/core/src/a.ts', 1));
        const run = runMerge(['--normalize', raw, join(dir, 'out.json')]);
        expect(run.stderr).toContain('paths outside the repo');
        expect(run.status).toBe(2);
      },
    );

    it.skipIf(inLinuxCopy)('a single --map or a repeated label is refused with exit 2', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cov-merge-'));
      const one = writeMap(dir, 'one.json', oneFileMap(file, 1));
      expect(runMerge(['--map', `windows=${one}`]).status).toBe(2);
      expect(runMerge(['--map', `a=${one}`, '--map', `a=${one}`]).status).toBe(2);
    });
  });
});
