import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { caughtClass, sieveDeliveryGaps } from './sieve-gate.ts';

/**
 * Проверка доставки на НАСТОЯЩЕМ git без удалённого (ревью сит, 28.09): механика
 * git молчит, но сита отчёта обязаны судиться по затронутым путям — раньше пустой
 * список путей делал применимых сит ноль, и копия сдавала «готово» без строк.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });
}

function repoWithoutRemote(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sieve-gate-'));
  dirs.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'README.md'), 'x\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'base']);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'work']);
  return root;
}

describe('сита на доставке без удалённого', () => {
  it('правка интерфейса без строки отчёта — пробел, а не «готово»', async () => {
    const cwd = repoWithoutRemote({ 'src/Button.tsx': 'export const B = 1;\n' });
    const result = await sieveDeliveryGaps({ cwd, rows: [] });

    expect(result.unchecked).toEqual(['no-remote']);
    expect(result.missing.some((line) => line.includes('browser-focus'))).toBe(true);
  });

  it('сданная строка с доказательством снимает сито', async () => {
    const cwd = repoWithoutRemote({ 'src/Button.tsx': 'export const B = 1;\n' });
    const result = await sieveDeliveryGaps({
      cwd,
      rows: [
        {
          id: 'browser-focus',
          status: 'pass',
          evidence: 'npx playwright test focus.spec.ts → 4 passed',
        },
      ],
    });

    expect(result.missing.some((line) => line.includes('browser-focus'))).toBe(false);
  });
});

describe('устаревшее снятие механики — пойманный блокер (Ф5)', () => {
  it('stale у механического сита идёт в счёт его класса, у обычного — нет', () => {
    expect(caughtClass({ code: 'sieve-gap-stale', params: { sieve: 'secrets', files: 'a' } })).toBe(
      'security',
    );
    expect(
      caughtClass({ code: 'sieve-gap-stale', params: { sieve: 'browser-focus', files: 'a' } }),
    ).toBeUndefined();
  });
});
