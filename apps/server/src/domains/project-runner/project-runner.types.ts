import type { ChildProcess } from 'node:child_process';
import type { ProjectRunnerStatus } from '@claude-control/contracts';

/** Пакетный менеджер проекта — по lock-файлу. */
export type PackageManager = 'pnpm' | 'yarn' | 'npm';

/** Что и как запускать: исполняемый файл, аргументы и человекочитаемая команда. */
export interface LaunchSpec {
  file: string;
  args: string[];
  /** Команда для показа пользователю (`pnpm run dev`). */
  display: string;
}

/** Поля package.json, которые нужны запуску. */
export interface PackageJsonShape {
  name?: string;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  /** Поле corepack: `"pnpm@9.1.0"` — прямое указание, чем запускать. */
  packageManager?: string;
}

/** Найденная цель до наложения пользовательских настроек. */
export interface RunnerTargetSpec {
  dir: string;
  path: string;
  name: string;
}

/** Что панель помнит про одну цель. */
export interface TargetMemory {
  command?: string;
  pinnedPort?: number;
  port?: number;
  autostart?: boolean;
}

/** Запись реестра: одна работающая (или упавшая) цель. */
export interface RunEntry {
  projectPath: string;
  dir: string;
  path: string;
  name: string;
  port?: number;
  url?: string;
  status: ProjectRunnerStatus;
  command: string;
  startedAt: string;
  error?: string;
  /** Порт, на который сервер пожаловался «уже занят». */
  busyPort?: number;
  child?: ChildProcess;
  /** Мы сами останавливаем — не превращать выход процесса в ошибку. */
  stopping: boolean;
  /** Автозапуск: браузер не открывать (окно всплыло бы само, без просьбы). */
  silent: boolean;
  /** Порт задан пользователем — из вывода его не переопределяем. */
  pinned: boolean;
  /** Хвост вывода: и для разбора адреса, и для показа в панели. */
  output: string;
}

/** Цель запуска в запросе: корень вкладки плюс подпапка. */
export interface RunnerTargetRef {
  projectPath: string;
  dir?: string;
}

/** Опции реестра: инъекции для тестов и связь с состоянием панели. */
export interface RunnerDeps {
  /** Открытие браузера — заглушка в тестах. */
  openBrowser?: (url: string) => void;
  /** Как получить команду запуска — тест подставит запуск node напрямую. */
  resolveLaunch?: (targetDir: string, override?: string, projectRoot?: string) => LaunchSpec;
  /**
   * Порт определился — панель его запоминает. Реестр не знает, где хранится
   * состояние, поэтому получает узкий колбэк, а не `AppStore`.
   */
  onPortDiscovered?: (run: { projectPath: string; dir: string; port: number }) => void;
  /** Сколько ждать адреса. Тест укорачивает — иначе ждал бы полминуты. */
  readyTimeoutMs?: number;
}

/**
 * Что автозапуску нужно от состояния панели. Узкий интерфейс вместо импорта
 * `AppStore`: реестр не должен ничего знать о том, где панель хранит состояние.
 */
export interface AutostartMemory {
  listAutostartProjects(): {
    path: string;
    projectPath?: string;
    dir?: string;
    command?: string;
    pinnedPort?: number;
  }[];
}

/** Итог автозапуска — для строчки в консоли при старте панели. */
export interface AutostartReport {
  started: { path: string; port?: number }[];
  failed: { path: string; message: string }[];
}

/** Ошибка запуска с кодом — маршрут превращает её в 400 с внятным текстом. */
export class RunnerError extends Error {
  code: 'bad-path' | 'no-script' | 'port-busy';
  /** Порт, из-за которого отказ, — панель предложит его освободить. */
  port?: number;
  constructor(code: 'bad-path' | 'no-script' | 'port-busy', message: string, port?: number) {
    super(message);
    this.code = code;
    this.port = port;
    this.name = 'RunnerError';
  }
}
