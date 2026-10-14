import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectLanguageChains, resolveLanguageStep } from './language-chains.ts';
import { bootstrapPlanFor, isHeavyPlan } from './bootstrap.ts';
import { venvPython, type RuntimeDeps } from './runtimes.ts';

/**
 * Среда Python и Go в копии (T15): что панель готовит по файлам проекта и как
 * ведёт себя, когда нужного интерпретатора на машине нет.
 */

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста не влияет.
  }
}

describe('detectLanguageChains', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-lang-'));
  });
  afterEach(() => dropTemp(dir));

  it('Python-сервис с requirements на первом уровне: venv и установка, мягкая цепочка', () => {
    mkdirSync(join(dir, 'svc'));
    writeFileSync(join(dir, 'svc', 'requirements.txt'), 'pytest\n');
    writeFileSync(join(dir, 'svc', 'requirements-dev.txt'), 'ruff\n');
    writeFileSync(join(dir, 'svc', 'app.py'), '');
    const chains = detectLanguageChains(dir);
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({ cwd: 'svc', soft: true });
    expect(chains[0]?.steps.map((step) => step.lang)).toEqual(['python-venv', 'python-deps']);
    expect(chains[0]?.steps[1]?.files).toEqual(['requirements.txt', 'requirements-dev.txt']);
  });

  it('requirements.txt для документации без Python-исходников и маркеров — не Python-проект', () => {
    writeFileSync(join(dir, 'requirements.txt'), 'mkdocs\n');
    expect(detectLanguageChains(dir)).toEqual([]);
  });

  it('uv.lock рядом с pyproject — uv sync вместо pip', () => {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "x"\n');
    writeFileSync(join(dir, 'uv.lock'), '');
    expect(detectLanguageChains(dir)[0]?.steps.map((step) => step.lang)).toEqual(['uv-sync']);
  });

  it('go.mod — прогрев кэша модулей; служебные каталоги мимо', () => {
    mkdirSync(join(dir, 'api'));
    writeFileSync(join(dir, 'api', 'go.mod'), 'module x\n\ngo 1.22\n');
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'dep', 'go.mod'), 'module y\n');
    const chains = detectLanguageChains(dir);
    expect(chains.map((chain) => chain.cwd)).toEqual(['api']);
    expect(chains[0]?.steps[0]).toMatchObject({ lang: 'go-download', command: 'go mod download' });
  });

  it('вместе с установкой Node: план один, но мягкие цепочки не делают его «тяжёлым»', () => {
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    mkdirSync(join(dir, 'svc'));
    writeFileSync(join(dir, 'svc', 'requirements.txt'), 'pytest\n');
    writeFileSync(join(dir, 'svc', 'main.py'), '');
    const plan = bootstrapPlanFor(dir, undefined);
    expect(plan?.chains.map((chain) => chain.cwd)).toEqual(['', 'svc']);
    expect(plan?.summary).toContain('npm ci');
    expect(plan?.summary).toContain('[svc] python -m venv .venv');
    expect(isHeavyPlan(plan)).toBe(false);
  });

  it('своя команда проекта отключает автоопределение языков', () => {
    mkdirSync(join(dir, 'svc'));
    writeFileSync(join(dir, 'svc', 'requirements.txt'), 'pytest\n');
    writeFileSync(join(dir, 'svc', 'main.py'), '');
    expect(bootstrapPlanFor(dir, 'make setup')?.chains).toHaveLength(1);
  });
});

describe('resolveLanguageStep', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-lang-res-'));
    mkdirSync(join(dir, 'svc'));
  });
  afterEach(() => dropTemp(dir));

  /** Запуск подменён: «py -0p» и `--version`/`-c` отвечают тем, что записано в таблице. */
  function machine(
    table: Record<string, string>,
    platform: NodeJS.Platform = 'linux',
  ): RuntimeDeps {
    return {
      exec: async (file, args) => table[`${file} ${args[0] ?? ''}`.trim()] ?? table[file],
      env: {},
      platform,
      home: dir,
    };
  }
  const venvStep = { cwd: 'svc', command: 'python -m venv .venv', lang: 'python-venv' as const };

  it('.python-version 3.12 и интерпретатор 3.12 на машине — venv на нём, а не на python3 по умолчанию', async () => {
    writeFileSync(join(dir, 'svc', '.python-version'), '3.12\n');
    const deps = machine({ python3: '3.14.0', 'python3.12': '3.12.7', python: '3.10.11' });
    const result = await resolveLanguageStep(dir, venvStep, deps);
    expect(result.command).toBe('python3.12 -m venv .venv');
    expect(result.note).toMatchObject({
      tool: 'python',
      status: 'ok',
      used: '3.12.7',
      wanted: '3.12',
    });
  });

  it('нужной версии нет — venv НЕ создаётся на чужой, причина и что есть — в записи', async () => {
    writeFileSync(join(dir, 'svc', '.python-version'), '3.12\n');
    const deps = machine({ python3: '3.14.0', python: '3.10.11' });
    const result = await resolveLanguageStep(dir, venvStep, deps);
    expect(result.command).toBeUndefined();
    expect(result.note).toMatchObject({ status: 'missing', wanted: '3.12' });
    expect(result.note?.detail).toContain('3.14.0');
    expect(result.log).toContain('3.12');
  });

  it('версия не названа — python3 по умолчанию', async () => {
    const result = await resolveLanguageStep(
      dir,
      venvStep,
      machine({ python3: '3.14.0', python: '3.10.11' }),
    );
    expect(result.command).toBe('python3 -m venv .venv');
  });

  it('готовый .venv в копии — используется как есть', async () => {
    const python = venvPython(join(dir, 'svc', '.venv'), 'linux');
    mkdirSync(join(dir, 'svc', '.venv', 'bin'), { recursive: true });
    writeFileSync(python, '');
    const result = await resolveLanguageStep(dir, venvStep, machine({}));
    expect(result.command).toBeUndefined();
    expect(result.note?.status).toBe('ok');
  });

  it('установка из requirements идёт интерпретатором venv; без venv — пропуск', async () => {
    const step = {
      cwd: 'svc',
      command: 'x',
      lang: 'python-deps' as const,
      files: ['requirements.txt', 'requirements-dev.txt'],
    };
    expect((await resolveLanguageStep(dir, step, machine({}))).command).toBeUndefined();
    mkdirSync(join(dir, 'svc', '.venv', 'bin'), { recursive: true });
    writeFileSync(venvPython(join(dir, 'svc', '.venv'), 'linux'), '');
    const result = await resolveLanguageStep(dir, step, machine({}));
    expect(result.command).toContain('-m pip install');
    expect(result.command).toContain('-r requirements.txt -r requirements-dev.txt');
  });

  it('Go: прогрев модулей; старый go без автотулчейна — missing', async () => {
    writeFileSync(join(dir, 'svc', 'go.mod'), 'module x\n\ngo 1.25.0\n');
    const step = { cwd: 'svc', command: 'go mod download', lang: 'go-download' as const };
    const fine = await resolveLanguageStep(
      dir,
      step,
      machine({ go: 'go version go1.25.3 linux/amd64' }),
    );
    expect(fine.command).toBe('go mod download');
    expect(fine.note).toMatchObject({ tool: 'go', status: 'ok', run: 'go test ./...' });
    const auto = await resolveLanguageStep(
      dir,
      step,
      machine({ go: 'go version go1.22.1 linux/amd64' }),
    );
    expect(auto.note?.status).toBe('ok');
    expect(auto.note?.detail).toContain('GOTOOLCHAIN');
    const old = await resolveLanguageStep(
      dir,
      step,
      machine({ go: 'go version go1.18 linux/amd64' }),
    );
    expect(old.note).toMatchObject({ status: 'missing' });
    const none = await resolveLanguageStep(dir, step, machine({}));
    expect(none.command).toBeUndefined();
    expect(none.note?.status).toBe('missing');
  });
});
