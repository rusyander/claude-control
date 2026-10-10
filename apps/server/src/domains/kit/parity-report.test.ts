import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Отчёт навыка сверки с макетом — на языке человека (решение 10.10): обвязка
 * страницы следует `lang` манифеста, а не зашитому русскому или английскому.
 * Гоняется настоящий скрипт набора на временном манифесте.
 */
const SCRIPT = fileURLToPath(
  new URL(
    '../../../assets/kit/agentdeck-kit/skills/figma-parity/tools/build-report.mjs',
    import.meta.url,
  ),
);

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function build(lang: string | undefined): string {
  dir = mkdtempSync(join(tmpdir(), 'parity-report-'));
  const manifest = join(dir, 'report.json');
  writeFileSync(
    manifest,
    JSON.stringify({
      ...(lang ? { lang } : {}),
      mode: 'AUTO',
      screens: [{ name: 'Вход', status: 'blocked', blockedReason: 'стенд недоступен' }],
    }),
  );
  const out = join(dir, 'report.html');
  const run = spawnSync(process.execPath, [SCRIPT, manifest, '--out', out, '--standalone'], {
    encoding: 'utf8',
  });
  expect(run.status, run.stderr).toBe(0);
  return readFileSync(out, 'utf8');
}

describe('отчёт сверки с макетом: язык обвязки', () => {
  it('lang ru — русская обвязка и <html lang="ru">', () => {
    const html = build('ru');
    expect(html).toContain('<html lang="ru">');
    expect(html).toContain('Почему заблокировано:');
    expect(html).toContain('<title>Сверка: фронт ↔ Figma</title>');
    expect(html).not.toContain('Why blocked:');
    // Текст агента не трогается.
    expect(html).toContain('стенд недоступен');
  });

  it('lang en и язык без своей обвязки — английская, <html lang="en">', () => {
    for (const lang of ['en', 'de-AT', undefined]) {
      const html = build(lang);
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('Why blocked:');
      expect(html).not.toContain('Почему заблокировано:');
    }
  });
});
