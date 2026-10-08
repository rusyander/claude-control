import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectChecks } from '../project-checks.ts';
import {
  artifactsIn,
  debugLeftoversIn,
  declaresEnv,
  destructiveIn,
  envReadsIn,
  LARGE_FILE_BYTES,
  lockfileGapsIn,
  secretsIn,
  untestedCodeIn,
} from './sieve-scan.ts';

/**
 * Механика сит — на точность: каждое срабатывание держит группу, поэтому здесь
 * рядом с каждым «ловит» стоит «не ловит» — то, на чём проверка краснела бы зря.
 */

const add = (path: string, text: string) => ({ path, text });

/**
 * Поддельные ключи собираются из частей: литерал формы вендора в исходнике —
 * ровно то, что ловит сито «секреты» (и сканер секретов форджа), даже в тесте.
 */
const FAKE_STRIPE = ['sk', 'live', 'FAKEfakeFAKEfake0000'].join('_');
const FAKE_GITHUB = ['ghp', 'FAKEfakeFAKEfakeFAKEfake0000'].join('_');

describe('секреты в добавленных строках', () => {
  it('ключи вендоров, JWT, пароль в адресе и приватный ключ — ловит', () => {
    expect(
      secretsIn([
        add('src/pay.ts', `const key = '${FAKE_STRIPE}';`),
        add('deploy/app.yaml', 'url: postgres://app:S3cretPass@db:5432/app'),
        add('certs/dev.pem', '-----BEGIN RSA PRIVATE KEY-----'),
        add('src/gh.ts', `token = "${FAKE_GITHUB}"`),
      ]),
    ).toEqual(['certs/dev.pem', 'deploy/app.yaml', 'src/gh.ts', 'src/pay.ts']);
  });

  it('хеши, uuid, переменные и лок-файлы — не ловит', () => {
    expect(
      secretsIn([
        add('src/a.ts', 'const id = "3f2a9c1e-77b4-4c1a-9a3e-0d1f2e3a4b5c";'),
        add('src/b.ts', 'const key = process.env.STRIPE_KEY;'),
        add(
          'src/c.ts',
          'const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";',
        ),
        add('pnpm-lock.yaml', 'integrity: sha512-sk-abcdefghijklmnopqrstuvwxyz'),
      ]),
    ).toEqual([]);
  });
});

describe('остатки отладки', () => {
  it('.only и fit в тестах, debugger и breakpoint() в коде, маркер конфликта где угодно', () => {
    expect(
      debugLeftoversIn([
        add('src/list.test.ts', "  it.only('sorts', () => {"),
        add('e2e/login.spec.ts', "fdescribe('login', () => {"),
        add('src/list.ts', '  debugger;'),
        add('app/views.py', '    breakpoint()'),
        add('README.md', '<<<<<<< HEAD'),
      ]),
    ).toEqual([
      'README.md',
      'app/views.py',
      'e2e/login.spec.ts',
      'src/list.test.ts',
      'src/list.ts',
    ]);
  });

  it('слово only, строка про debugger и ======= в тексте — не ловит', () => {
    expect(
      debugLeftoversIn([
        add('src/a.ts', 'const only = items.filter((it) => it.only);'),
        add('src/b.ts', "log('attach a debugger; then retry');"),
        add('docs/x.md', '======== section ========'),
        add('src/c.test.ts', "it('only admins see it', () => {"),
      ]),
    ).toEqual([]);
  });
});

describe('манифест без лок-файла', () => {
  const tracked = [
    'package.json',
    'pnpm-lock.yaml',
    'svc/go.mod',
    'svc/go.sum',
    'tool/package.json',
  ];

  it('зависимость поменялась, лок — нет: ловит; лок тоже поменялся — нет', () => {
    const lines = [add('package.json', '    "zod": "^3.23.8",')];
    expect(lockfileGapsIn({ changed: ['package.json'], lines, tracked })).toEqual(['package.json']);
    expect(lockfileGapsIn({ changed: ['package.json', 'pnpm-lock.yaml'], lines, tracked })).toEqual(
      [],
    );
  });

  it('правка скрипта — не зависимость; проекта без лока — не требуем', () => {
    const script = [add('package.json', '    "lint": "eslint .",')];
    expect(lockfileGapsIn({ changed: ['package.json'], lines: script, tracked })).toEqual([]);
    const dep = [add('tool/package.json', '    "chalk": "^5.0.0",')];
    // Лок рабочей области лежит в корне — он и должен был поменяться.
    expect(lockfileGapsIn({ changed: ['tool/package.json'], lines: dep, tracked })).toEqual([
      'tool/package.json',
    ]);
    expect(
      lockfileGapsIn({
        changed: ['package.json'],
        lines: dep.map((l) => ({ ...l, path: 'package.json' })),
        tracked: ['package.json'],
      }),
    ).toEqual([]);
  });

  it('go.mod с новой зависимостью без go.sum — ловит', () => {
    const lines = [add('svc/go.mod', '\tgithub.com/google/uuid v1.6.0')];
    expect(lockfileGapsIn({ changed: ['svc/go.mod'], lines, tracked })).toEqual(['svc/go.mod']);
  });
});

describe('новые переменные окружения', () => {
  it('чтение без значения по умолчанию на разных языках — ловит', () => {
    expect(
      envReadsIn([
        add('src/pay.ts', 'const url = process.env.PAYMENTS_URL;'),
        add('app/settings.py', 'TOKEN = os.environ["SLACK_TOKEN"]'),
        add('cmd/main.go', 'addr := os.Getenv("LISTEN_ADDR")'),
      ]),
    ).toEqual(['LISTEN_ADDR', 'PAYMENTS_URL', 'SLACK_TOKEN']);
  });

  it('со значением по умолчанию, системные и в тестах — не ловит', () => {
    expect(
      envReadsIn([
        add('src/a.ts', "const level = process.env.LOG_LEVEL ?? 'info';"),
        add('app/b.py', 'x = os.getenv("TIMEOUT_SEC", "30")'),
        add('src/c.ts', 'if (process.env.NODE_ENV === "production") {}'),
        add('src/d.test.ts', 'process.env.FAKE_URL = "x";'),
      ]),
    ).toEqual([]);
  });

  it('объявлением считаются конфиг и доки, но не код и тесты', () => {
    expect(declaresEnv('.env.example')).toBe(true);
    // Закоммиченный локальный .env — утечка, а не объявление.
    expect(declaresEnv('.env.local')).toBe(false);
    expect(declaresEnv('.env')).toBe(false);
    expect(declaresEnv('deploy/values.yaml')).toBe(true);
    expect(declaresEnv('docs/config.md')).toBe(true);
    expect(declaresEnv('src/config.ts')).toBe(false);
    expect(declaresEnv('src/config.test.ts')).toBe(false);
  });
});

describe('разрушающие миграции, код без тестов, лишнее в git', () => {
  it('DROP в миграции — ловит; DROP в обычном коде и CREATE в миграции — нет', () => {
    expect(
      destructiveIn([
        add('db/migrations/0042_legacy.sql', 'ALTER TABLE users DROP COLUMN legacy_id;'),
        add(
          'app/migrations/0007_auto.py',
          "        migrations.RemoveField(model_name='user', name='nick'),",
        ),
        add('src/sql.ts', "const q = 'DROP TABLE tmp';"),
        add('db/migrations/0043_add.sql', 'CREATE TABLE audit (id int);'),
      ]),
    ).toEqual(['app/migrations/0007_auto.py', 'db/migrations/0042_legacy.sql']);
  });

  it('код без единого теста в ветке — ловит; тест рядом или только доки — нет', () => {
    expect(untestedCodeIn(['src/a.ts', 'README.md'])).toEqual(['src/a.ts']);
    expect(untestedCodeIn(['src/a.ts', 'src/a.test.ts'])).toEqual([]);
    expect(untestedCodeIn(['README.md', '.github/workflows/ci.yml'])).toEqual([]);
  });

  it('.env, ключ, игнорируемое и крупное — ловит; .env.example и обычный файл — нет', () => {
    expect(
      artifactsIn({
        added: [
          '.env.local',
          'deploy/key.pem',
          'dist/app.js',
          'data/dump.bin',
          '.env.example',
          'src/a.ts',
        ],
        ignored: ['dist/app.js'],
        sizes: { 'data/dump.bin': LARGE_FILE_BYTES + 1, 'src/a.ts': 2_000 },
      }),
    ).toEqual(['.env.local', 'data/dump.bin', 'deploy/key.pem', 'dist/app.js']);
  });
});

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
