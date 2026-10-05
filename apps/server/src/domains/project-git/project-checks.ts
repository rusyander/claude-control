import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectCheck } from '@agentdeck/contracts/sieves';

/**
 * Какими командами проект проверяет себя — lint, типы, тесты, — найденными по
 * его собственным манифестам, чтобы сито `project-checks` называло агенту
 * ТОЧНЫЕ команды, а доказательство судилось по каждой.
 *
 * Класс блокера — «CI красный после MR»: агент прогнал один тест из пяти и
 * написал «проверено». Команды не придумываются: только то, что объявил сам
 * проект (скрипт в package.json, цель Makefile, конфиг инструмента, манифест
 * языка с его штатной командой). Сборка (`build`) не входит — это не проверка,
 * и на большом проекте она съела бы весь ход.
 */

/** Скрипты package.json, которые являются проверками, — в порядке, в каком их гонять. */
const SCRIPT_CHECKS = [
  'lint',
  'format:check',
  'typecheck',
  'type-check',
  'check-types',
  'types',
  'check',
  'test',
] as const;

function read(root: string, file: string): string | undefined {
  try {
    return readFileSync(join(root, file), 'utf8');
  } catch {
    return undefined;
  }
}

/** Менеджер пакетов проекта — по его лок-файлу; нет лока — npm. */
function packageManager(root: string): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

/** Команда скрипта и её вторая запись: `pnpm lint` ≡ `pnpm run lint`, `npm test` ≡ `npm run test`. */
function scriptCheck(pm: ReturnType<typeof packageManager>, script: string): ProjectCheck {
  const run = `${pm} run ${script}`;
  if (pm === 'npm')
    return script === 'test' ? { command: 'npm test', aliases: [run] } : { command: run };
  if (pm === 'bun') return { command: run };
  return { command: `${pm} ${script}`, aliases: [run] };
}

/** Штатные команды языков — только когда проект объявил сам инструмент. */
function languageChecks(root: string): ProjectCheck[] {
  const checks: ProjectCheck[] = [];
  const pyproject = read(root, 'pyproject.toml') ?? '';
  const python =
    pyproject !== '' || existsSync(join(root, 'setup.cfg')) || existsSync(join(root, 'setup.py'));
  if (python) {
    if (/\[tool\.ruff\b/.test(pyproject) || existsSync(join(root, 'ruff.toml'))) {
      checks.push({ command: 'ruff check .', aliases: ['ruff check'] });
    }
    if (/\[tool\.mypy\b/.test(pyproject) || existsSync(join(root, 'mypy.ini'))) {
      checks.push({ command: 'mypy .', aliases: ['mypy'] });
    }
    if (
      /\[tool\.pytest\b/.test(pyproject) ||
      existsSync(join(root, 'pytest.ini')) ||
      existsSync(join(root, 'conftest.py')) ||
      existsSync(join(root, 'tests'))
    ) {
      checks.push({ command: 'pytest' });
    }
  }
  if (existsSync(join(root, 'go.mod'))) {
    checks.push({ command: 'go vet ./...', aliases: ['go vet'] });
    checks.push({ command: 'go test ./...', aliases: ['go test'] });
  }
  if (existsSync(join(root, 'Cargo.toml'))) {
    checks.push({ command: 'cargo clippy --all-targets', aliases: ['cargo clippy'] });
    checks.push({ command: 'cargo test' });
  }
  const gemfile = read(root, 'Gemfile') ?? '';
  if (/\brubocop\b/.test(gemfile)) checks.push({ command: 'bundle exec rubocop' });
  if (/\brspec\b/.test(gemfile)) checks.push({ command: 'bundle exec rspec' });
  if (existsSync(join(root, 'gradlew'))) {
    checks.push({ command: './gradlew check' });
  } else if (existsSync(join(root, 'pom.xml'))) {
    checks.push({ command: 'mvn -q verify', aliases: ['mvn verify'] });
  }
  return checks;
}

/** Цели Makefile, которые являются проверками. */
function makeChecks(root: string, taken: ReadonlySet<string>): ProjectCheck[] {
  const makefile = read(root, 'Makefile') ?? read(root, 'makefile') ?? '';
  const targets = ['lint', 'typecheck', 'check', 'test'].filter(
    (target) => !taken.has(target) && new RegExp(`^${target}\\s*:`, 'm').test(makefile),
  );
  return targets.map((target) => ({ command: `make ${target}` }));
}

/** Проверки проекта в корне `root`; ничего не объявлено — пусто, и сито молчит о командах. */
export function projectChecks(root: string): ProjectCheck[] {
  const checks: ProjectCheck[] = [];
  const taken = new Set<string>();
  const manifest = read(root, 'package.json');
  if (manifest) {
    try {
      const scripts = (JSON.parse(manifest) as { scripts?: Record<string, unknown> }).scripts ?? {};
      const pm = packageManager(root);
      for (const script of SCRIPT_CHECKS) {
        const body = scripts[script];
        // Заглушка npm init («no test specified») — не проверка.
        if (typeof body !== 'string' || /no test specified/.test(body)) continue;
        checks.push(scriptCheck(pm, script));
        taken.add(script);
      }
    } catch {
      // Битый package.json покажет сам проект; сито без команд — не повод падать.
    }
  }
  checks.push(...makeChecks(root, taken), ...languageChecks(root));
  const composer = read(root, 'composer.json');
  if (composer && /"test"\s*:/.test(composer)) checks.push({ command: 'composer test' });
  return checks;
}
