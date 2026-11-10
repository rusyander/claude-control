import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Пин Playwright ядра против установленного в корне (этап 12, W3-D). Браузер прохода ядро берёт
 * из кеша Playwright, который ставит `pnpm qa:setup` корневым `playwright`; `playwright-core` ядра
 * приколот точно. Разойдутся версии — ядро ищет Chromium другой сборки и отвечает `no-browser`,
 * хотя браузер стоит. Проверка читает оба package.json при прогоне и краснеет на любом расхождении.
 *
 * `AGENTDECK_CORE_PKG` — путь к package.json ядра вместо настоящего: мутант правит пин во
 * временной копии, настоящий файл не трогается.
 */

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const CORE_PKG = process.env.AGENTDECK_CORE_PKG ?? here('../../../package.json');
const ROOT_PLAYWRIGHT = here('../../../../../node_modules/playwright/package.json');
const CORE_PLAYWRIGHT = here('../../../node_modules/playwright-core/package.json');

const versionOf = (path: string): string =>
  (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;

/** Расхождение пина с установленной версией; `null` — совпадают. */
function pinDrift(corePkgText: string, installed: string): string | null {
  const deps = (JSON.parse(corePkgText) as { dependencies?: Record<string, string> }).dependencies;
  const pin = deps?.['playwright-core'];
  if (!pin) return 'apps/core/package.json has no playwright-core dependency';
  if (!/^\d+\.\d+\.\d+$/.test(pin))
    return `playwright-core is pinned as "${pin}": the core pin must be an exact version`;
  return pin === installed
    ? null
    : `core pins playwright-core ${pin}, the root installs playwright ${installed}: align them in one pass`;
}

const rootInstalled = existsSync(ROOT_PLAYWRIGHT);
if (!rootInstalled)
  console.warn('playwright-pin: skipped — root node_modules/playwright is absent');

describe.skipIf(!rootInstalled)(
  'core playwright-core pin vs the installed root playwright (stage 12, W3-D)',
  () => {
    it('the exact core pin equals the installed root playwright and the installed core playwright-core', () => {
      const installed = versionOf(ROOT_PLAYWRIGHT);
      expect(pinDrift(readFileSync(CORE_PKG, 'utf8'), installed)).toBeNull();
      if (existsSync(CORE_PLAYWRIGHT)) expect(versionOf(CORE_PLAYWRIGHT)).toBe(installed);
    });

    it('a temp copy with a moved pin or a range is red, naming both versions', () => {
      const installed = versionOf(ROOT_PLAYWRIGHT);
      const dir = mkdtempSync(join(tmpdir(), 'pw-pin-'));
      try {
        const copy = join(dir, 'package.json');
        const text = readFileSync(CORE_PKG, 'utf8');
        writeFileSync(
          copy,
          text.replace(/"playwright-core": "[^"]+"/, '"playwright-core": "0.0.1"'),
        );
        expect(pinDrift(readFileSync(copy, 'utf8'), installed)).toBe(
          `core pins playwright-core 0.0.1, the root installs playwright ${installed}: align them in one pass`,
        );
        writeFileSync(
          copy,
          text.replace(/"playwright-core": "[^"]+"/, `"playwright-core": "^${installed}"`),
        );
        expect(pinDrift(readFileSync(copy, 'utf8'), installed)).toMatch(/must be an exact version/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
