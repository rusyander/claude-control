import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KitMode, ModelBench } from '@agentdeck/contracts/local-models';
import { writeTextFile } from '../../lib/safe-io.ts';

/**
 * Всё локальное — в ОДНОМ каталоге внутри панели: `<корень приложения>/.local-models`.
 *
 * Внутри панели, а не в `~/.ollama` и не в профиле пользователя, по слову
 * владельца: человек должен видеть, где лежат гигабайты, и убирать их одной
 * кнопкой (или удалением папки), не вспоминая, какая программа куда что
 * положила. Каталог в `.gitignore`.
 */
export const LOCAL_MODELS_DIR = '.local-models';
/** Порт нашего сервера моделей. Не 11434: тот принадлежит Ollama пользователя, если он стоит. */
export const LOCAL_SERVER_PORT = 11435;

export interface LocalPaths {
  root: string;
  runtime: string;
  models: string;
  downloads: string;
  tools: string;
  logs: string;
  run: string;
  state: string;
  pidFile: string;
  serverLog: string;
}

export function localPaths(appRoot: string, env: NodeJS.ProcessEnv = process.env): LocalPaths {
  // Переопределение — для проверок: они гоняют весь путь на временном каталоге,
  // не трогая гигабайты владельца.
  const root = env.AGENTDECK_LOCAL_MODELS_DIR?.trim() || join(appRoot, LOCAL_MODELS_DIR);
  return {
    root,
    runtime: join(root, 'runtime'),
    models: join(root, 'models'),
    downloads: join(root, 'downloads'),
    tools: join(root, 'tools'),
    logs: join(root, 'logs'),
    run: join(root, 'run'),
    state: join(root, 'state.json'),
    pidFile: join(root, 'run', 'ollama.json'),
    serverLog: join(root, 'logs', 'ollama.log'),
  };
}

export function ensureDirs(paths: LocalPaths): void {
  for (const dir of [
    paths.root,
    paths.runtime,
    paths.models,
    paths.downloads,
    paths.tools,
    paths.logs,
    paths.run,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Что раздел помнит между запусками панели. */
export interface LocalState {
  /** Версия сервера, как ответил `/api/version`, по пути исполняемого файла. */
  versions: Record<string, string>;
  /** Взять свою копию сервера, даже если в системе стоит своя. */
  preferPanelRuntime: boolean;
  bench: Record<string, ModelBench>;
  kit: { claude: KitMode; qwen: KitMode; variant: 'standard' | 'local' };
}

export function defaultState(): LocalState {
  return {
    versions: {},
    preferPanelRuntime: false,
    bench: {},
    kit: { claude: 'global', qwen: 'global', variant: 'local' },
  };
}

export function readState(paths: LocalPaths): LocalState {
  if (!existsSync(paths.state)) return defaultState();
  try {
    const raw = JSON.parse(readFileSync(paths.state, 'utf8')) as Partial<LocalState>;
    const base = defaultState();
    return {
      versions: raw.versions ?? base.versions,
      preferPanelRuntime: raw.preferPanelRuntime ?? base.preferPanelRuntime,
      bench: raw.bench ?? base.bench,
      kit: { ...base.kit, ...(raw.kit ?? {}) },
    };
  } catch {
    // Испорченный файл состояния не должен запирать раздел: начинаем с умолчаний.
    return defaultState();
  }
}

export function writeState(paths: LocalPaths, state: LocalState): void {
  mkdirSync(paths.root, { recursive: true });
  writeTextFile(paths.state, `${JSON.stringify(state, null, 2)}\n`);
}

export function updateState(paths: LocalPaths, change: (state: LocalState) => void): LocalState {
  const state = readState(paths);
  change(state);
  writeState(paths, state);
  return state;
}
