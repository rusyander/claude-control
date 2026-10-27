import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { playwrightTargets, sameStand, standTargets } from './runner-target.ts';

/** Конфиг как у пакета e2e монорепозитория: общий адрес из переменной, у проекта inst — свой. */
const CONFIG = `import { defineConfig } from '@playwright/test';
// baseURL: 'http://commented.example' — комментарий не адрес
const SHARED = process.env.E2E_BASE_URL ?? 'https://inst.dev.example.com';
export default defineConfig({
  testDir: '.',
  use: { baseURL: SHARED, trace: 'off' },
  projects: [
    { name: 'inst', testDir: './inst', use: { baseURL: process.env['INST_URL'] || "http://localhost:5173" } },
    { name: 'cp', testDir: 'cp/' },
  ],
});
`;

describe('runner-target: адрес стенда из конфига Playwright', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('проект со своим testDir и baseURL — свой адрес, проект без адреса — общий, переменная первой', () => {
    expect(playwrightTargets(CONFIG, {})).toEqual([
      {
        testDir: 'inst',
        url: 'http://localhost:5173',
        from: 'INST_URL не задан — по умолчанию конфига',
      },
      {
        testDir: 'cp',
        url: 'https://inst.dev.example.com',
        from: 'E2E_BASE_URL не задан — по умолчанию конфига',
      },
      { url: 'https://inst.dev.example.com', from: 'E2E_BASE_URL не задан — по умолчанию конфига' },
    ]);
    expect(playwrightTargets(CONFIG, { INST_URL: 'http://127.0.0.1:9000' })[0]).toEqual({
      testDir: 'inst',
      url: 'http://127.0.0.1:9000',
      from: 'INST_URL',
    });
  });

  it('файлы пакета — адреса только своих проектов; webServer в конфиге назван', () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-runner-target-'));
    writeFileSync(join(dir, 'playwright.config.ts'), CONFIG);
    const found = standTargets(dir, ['inst/users/users.spec.ts'], {});
    expect(found.urls).toEqual([
      { url: 'http://localhost:5173', from: 'INST_URL не задан — по умолчанию конфига' },
    ]);
    expect(found.webServer).toBe(false);
    writeFileSync(
      join(dir, 'playwright.config.ts'),
      `export default { use: { baseURL: 'http://localhost:3000' }, webServer: { command: 'npm start' } };\n`,
    );
    expect(standTargets(dir, ['a.spec.ts'], {}).webServer).toBe(true);
  });

  it('sameStand: localhost ≡ 127.0.0.1, порт и схема различают', () => {
    expect(sameStand('http://localhost:5173/healthz', 'http://127.0.0.1:5173')).toBe(true);
    expect(sameStand('http://localhost:5173', 'http://localhost:5174')).toBe(false);
    expect(sameStand('https://inst.dev.example.com', 'http://localhost:5173')).toBe(false);
  });
});
