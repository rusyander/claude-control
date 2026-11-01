import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectChecks } from './project-checks.ts';

describe('команды проверок проекта', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const project = (files: Record<string, string>): string => {
    dir = mkdtempSync(join(tmpdir(), 'cc-checks-'));
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), body);
    }
    return dir;
  };

  it('скрипты package.json — командой менеджера проекта, со второй записью', () => {
    const root = project({
      'package.json': JSON.stringify({
        scripts: { build: 'vite build', lint: 'eslint .', 'type-check': 'tsc', test: 'vitest run' },
      }),
      'pnpm-lock.yaml': '',
    });
    expect(projectChecks(root)).toEqual([
      { command: 'pnpm lint', aliases: ['pnpm run lint'] },
      { command: 'pnpm type-check', aliases: ['pnpm run type-check'] },
      { command: 'pnpm test', aliases: ['pnpm run test'] },
    ]);
  });

  it('заглушка npm init — не проверка; npm test — своей записью', () => {
    const stub = project({
      'package.json': JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      }),
    });
    expect(projectChecks(stub)).toEqual([]);
    rmSync(stub, { recursive: true, force: true });
    const real = project({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) });
    expect(projectChecks(real)).toEqual([{ command: 'npm test', aliases: ['npm run test'] }]);
  });

  it('Go, Rust и Python — штатные команды, только когда инструмент объявлен', () => {
    const go = project({ 'go.mod': 'module x' });
    expect(projectChecks(go).map((check) => check.command)).toEqual([
      'go vet ./...',
      'go test ./...',
    ]);
    rmSync(go, { recursive: true, force: true });
    const py = project({
      'pyproject.toml': '[tool.ruff]\nline-length = 100\n[tool.pytest.ini_options]\n',
    });
    expect(projectChecks(py).map((check) => check.command)).toEqual(['ruff check .', 'pytest']);
  });

  it('пустой каталог — ни одной команды', () => {
    expect(projectChecks(project({ 'README.md': '# x' }))).toEqual([]);
  });
});
