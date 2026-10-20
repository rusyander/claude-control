import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WorktreeRuntimeNote } from '@agentdeck/contracts';
import type { BootstrapChain, BootstrapStep } from './bootstrap.types.ts';
import {
  defaultVersion,
  findPython,
  readGoNeed,
  readPythonNeed,
  venvPython,
  type RuntimeDeps,
} from './runtimes.ts';
import { formatVersion, satisfiesRange } from '../../lib/runtime-range/runtime-range.ts';
import { shellQuote } from '../../lib/shell-quote.ts';

/**
 * Среда языков, кроме Node: Python и Go (T15, живое ревью MR 13.10.2026).
 *
 * Копия получала `node_modules`, а Python и Go оставляла голыми: ревьюер видел
 * системные Python 3.14 и 3.10 без pytest, собирал `venv` на версии, которую
 * проект не просит (3.14 при 3.12), и десять минут ждал установку; на Go —
 * `missing go.sum entry`. Теперь панель сама:
 *  - Python: venv `.venv` на интерпретаторе, подходящем `.python-version` /
 *    `requires-python`, и установка из `requirements*.txt` (или `uv sync`, где
 *    есть `uv.lock`). Подходящего интерпретатора нет — venv НЕ создаётся на
 *    чужой версии, строка о нехватке уходит на карточку;
 *  - Go: `go mod download` — прогрев кэша модулей без записи в дерево.
 * Это МЯГКИЕ цепочки: их провал не проваливает подготовку (она про зависимости
 * проекта), а ложится на карточку и в задание строкой. Свои команды человек
 * задаёт полем «Команда после создания копии» — оно отключает автоопределение.
 */

/** Потолок мягкой цепочки: дольше — процесс снимается, группа идёт дальше. */
export const SOFT_CHAIN_TIMEOUT_MS = 5 * 60 * 1000;

const SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'target',
  'venv',
  'env',
  '__pycache__',
  'site-packages',
]);

/** Корень и каталоги первого уровня: глубже сервисы монорепозитория не живут. */
function languageDirs(dir: string): string[] {
  try {
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith('.') && !SKIP_DIRS.has(name))
      .sort();
    return ['', ...names];
  } catch {
    return [''];
  }
}

const PYTHON_MARKERS = [
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'pytest.ini',
  'tox.ini',
  'manage.py',
];

/** Файлы зависимостей, которые ставит панель: основной и то, что называют тестовым. */
const REQUIREMENT_FILES = [
  'requirements.txt',
  'requirements-dev.txt',
  'requirements_dev.txt',
  'dev-requirements.txt',
  'requirements-test.txt',
  'requirements_test.txt',
  'test-requirements.txt',
  join('requirements', 'base.txt'),
  join('requirements', 'dev.txt'),
  join('requirements', 'test.txt'),
];

function hasPythonSources(abs: string): boolean {
  try {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.py')) return true;
      if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
        const inner = readdirSync(join(abs, entry.name), { withFileTypes: true });
        if (inner.some((item) => item.isFile() && item.name.endsWith('.py'))) return true;
      }
    }
  } catch {
    // Каталог не читается — Python в нём не ищем.
  }
  return false;
}

/**
 * Каталог — Python-проект, а не папка с `requirements.txt` для документации:
 * нужен маркер проекта или исходники рядом с требованиями.
 */
function isPythonProject(abs: string, requirements: readonly string[]): boolean {
  if (PYTHON_MARKERS.some((name) => existsSync(join(abs, name)))) return true;
  return requirements.length > 0 && hasPythonSources(abs);
}

/** Цепочки Python и Go по файлам копии; пусто — языков вне Node в проекте нет. */
export function detectLanguageChains(dir: string): BootstrapChain[] {
  const chains: BootstrapChain[] = [];
  for (const cwd of languageDirs(dir)) {
    const abs = join(dir, cwd);
    if (existsSync(join(abs, 'go.mod'))) {
      chains.push({
        cwd,
        soft: true,
        after: [],
        steps: [{ cwd, command: 'go mod download', lang: 'go-download' }],
      });
    }
    const requirements = REQUIREMENT_FILES.filter((name) => existsSync(join(abs, name)));
    if (!isPythonProject(abs, requirements)) continue;
    if (existsSync(join(abs, 'uv.lock')) && existsSync(join(abs, 'pyproject.toml'))) {
      chains.push({
        cwd,
        soft: true,
        after: [],
        steps: [{ cwd, command: 'uv sync --frozen', lang: 'uv-sync' }],
      });
      continue;
    }
    if (requirements.length === 0) continue;
    const steps: BootstrapStep[] = [
      { cwd, command: 'python -m venv .venv', lang: 'python-venv' },
      {
        cwd,
        command: `.venv/python -m pip install ${requirements.map((name) => `-r ${name.replace(/\\/g, '/')}`).join(' ')}`,
        lang: 'python-deps',
        files: requirements,
      },
    ];
    chains.push({ cwd, soft: true, after: [], steps });
  }
  return chains;
}

/** Что вышло из подготовки шага языка: команда или пропуск, и строка для карточки. */
export interface LanguageStepResult {
  /** Команда для оболочки; нет — шаг пропущен (причина в `note`). */
  command?: string;
  note?: WorktreeRuntimeNote;
  /** Строка в лог подготовки. */
  log?: string;
}

/**
 * Собрать настоящую команду шага языка на этой машине. Не бросает: нет
 * интерпретатора, утилиты или нужной версии — это пропуск с названной причиной.
 */
export async function resolveLanguageStep(
  root: string,
  step: BootstrapStep,
  deps: RuntimeDeps,
): Promise<LanguageStepResult> {
  const where = step.cwd;
  const abs = resolve(root, where);
  const venvDir = join(abs, '.venv');
  const python = venvPython(venvDir, deps.platform);
  const quote = (path: string) => shellQuote(path, deps.platform);
  const runVenv = `${deps.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python'} -m pytest`;
  switch (step.lang) {
    case 'python-venv': {
      const need = readPythonNeed(root, where);
      if (existsSync(python)) {
        return {
          log: 'venv .venv уже есть — используется как есть',
          note: {
            tool: 'python',
            where,
            wanted: need?.wanted ?? '',
            source: need?.source ?? '',
            status: 'ok',
            detail: 'готовый .venv в копии',
            run: runVenv,
          },
        };
      }
      const { best, all } = await findPython(need?.wanted, deps);
      // Версии проект не называет — берём то, что стоит по умолчанию (`python3`/`python`).
      const chosen = need
        ? best
        : (all.find((item) => item.command === 'python3') ??
          all.find((item) => item.command === 'python') ??
          all[0]);
      if (!chosen) {
        const have = all.map((item) => item.text).join(', ') || 'ни одного интерпретатора';
        return {
          log: need
            ? `Python ${need.wanted} (${need.source}) не найден на машине (есть: ${have}) — venv не создан: на чужой версии тесты дали бы ложный результат`
            : 'интерпретатор Python не найден — venv не создан',
          note: {
            tool: 'python',
            where,
            wanted: need?.wanted ?? '',
            source: need?.source ?? '',
            status: 'missing',
            ...(all[0] ? { found: all[0].text } : {}),
            detail: `установите Python ${need?.wanted ?? ''} (pyenv, py-лаунчер, uv) и повторите установку; есть: ${have}`,
          },
        };
      }
      return {
        command: `${quote(chosen.command)} -m venv .venv`,
        log: `интерпретатор ${chosen.text} (${chosen.command})`,
        note: {
          tool: 'python',
          where,
          wanted: need?.wanted ?? '',
          source: need?.source ?? '',
          status: 'ok',
          used: chosen.text,
          run: runVenv,
        },
      };
    }
    case 'python-deps': {
      if (!existsSync(python)) return { log: 'venv нет — зависимости Python не ставятся' };
      const files = (step.files ?? []).map((name) => `-r ${quote(name)}`).join(' ');
      return {
        command: `${quote(python)} -m pip install --disable-pip-version-check ${files}`,
      };
    }
    case 'uv-sync': {
      const need = readPythonNeed(root, where);
      const version = await deps.exec('uv', ['--version'], deps.env);
      if (!version) {
        return {
          log: 'uv не найден — окружение по uv.lock не готовится',
          note: {
            tool: 'python',
            where,
            wanted: need?.wanted ?? '',
            source: need?.source ?? 'uv.lock',
            status: 'missing',
            detail: 'в проекте uv.lock, а утилиты uv на машине нет',
          },
        };
      }
      return {
        command: 'uv sync --frozen',
        note: {
          tool: 'python',
          where,
          wanted: need?.wanted ?? '',
          source: need?.source ?? 'uv.lock',
          status: 'ok',
          run: 'uv run pytest',
        },
      };
    }
    case 'go-download': {
      const need = readGoNeed(root, where);
      const current = await defaultVersion('go', deps);
      const base = {
        tool: 'go' as const,
        where,
        wanted: need?.wanted ?? '',
        source: need?.source ?? 'go.mod',
      };
      if (!current) {
        return {
          log: 'go не найден — модули не прогреты',
          note: { ...base, status: 'missing', detail: 'Go на машине нет' },
        };
      }
      const fits = need ? satisfiesRange(current.version, need.wanted) : true;
      // Go 1.21+ сам докачивает нужный тулчейн (GOTOOLCHAIN=auto): старее нужного — не отказ.
      const auto = current.version[0] > 1 || current.version[1] >= 21;
      return {
        command: 'go mod download',
        note: {
          ...base,
          status: fits === false && !auto ? 'missing' : 'ok',
          used: formatVersion(current.version),
          run: 'go test ./...',
          ...(fits === false
            ? {
                detail: auto
                  ? `у Go ${current.text} нужная версия докачивается самим go (GOTOOLCHAIN=auto)`
                  : `нужен Go ${need?.wanted}, на машине ${current.text}`,
              }
            : {}),
        },
      };
    }
    default:
      return { command: step.command };
  }
}
