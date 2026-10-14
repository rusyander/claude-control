/**
 * Что значит шаг языка (не Node): команда собирается в момент запуска, потому
 * что интерпретатор и его версия известны только машине, а не плану.
 */
export type LanguageStepKind = 'python-venv' | 'python-deps' | 'uv-sync' | 'go-download';

/** Одна команда подготовки; `cwd` — каталог относительно корня копии, `''` — сам корень. */
export interface BootstrapStep {
  cwd: string;
  command: string;
  /** Шаг языка: `command` — только подпись для карточки, настоящая собирается при запуске. */
  lang?: LanguageStepKind;
  /** Файлы зависимостей шага (`python-deps`) — относительно `cwd`. */
  files?: string[];
}

/**
 * Цепочка — шаги ОДНОГО каталога по порядку (установка, затем сборка);
 * `after` — каталоги, чьи цепочки должны кончиться раньше.
 */
export interface BootstrapChain {
  cwd: string;
  steps: BootstrapStep[];
  after: string[];
  /**
   * Мягкая цепочка — среда языка (Python, Go), а не зависимости самого проекта:
   * её провал или потолок не проваливают подготовку, а ложатся на карточку
   * строкой. Пока она идёт, группа ждёт, но не дольше `SOFT_CHAIN_TIMEOUT_MS`.
   */
  soft?: boolean;
}

/**
 * План подготовки копии: цепочки идут ПАРАЛЛЕЛЬНО, шаги в цепочке — по
 * порядку. `summary` — то, что человек видит в карточке копии и в состоянии.
 */
export interface BootstrapPlan {
  summary: string;
  chains: BootstrapChain[];
}
