import type { MutantOutcome, MutantPlanRow } from '@agentdeck/contracts/core/records';
import type { Fact } from '@agentdeck/contracts/core/facts';

/**
 * Мутанты ядра (04 §Tests block «Optional mutation step», 08:4-5, G6). Формат плана — тот же, что у
 * mustfail и `core-linux.mjs --mutants`: `[{file, find, replace, test, spec}]`.
 */

/** Один прогон одного теста — ответ раннера мутанта. */
export type TestRunOutcome =
  | {
      kind: 'ran';
      /** Найденные тесты под именем: путь «a > b > it» и итог. */
      tests: { path: string; status: 'passed' | 'failed' | 'skipped' }[];
      /** Файл не собрался (импорт, синтаксис) — это не падение теста на его утверждении. */
      fileErrors: string[];
      exit: number | null;
    }
  | { kind: 'not-run'; reason: string };

export interface TestRunner {
  run(row: Pick<MutantPlanRow, 'spec' | 'test'>, ctx: TestRunContext): Promise<TestRunOutcome>;
}

export interface TestRunContext {
  root: string;
  /** Каталог прогона под журналом: отчёт раннера живёт там и уходит вместе с резервными копиями. */
  scratchDir: string;
  /** Дети ставят MUSTFAIL_PID — `tools/mutation-guard.mjs` пропускает свой журнал. */
  env: NodeJS.ProcessEnv;
}

export interface MutantResult {
  row: MutantPlanRow;
  outcome: MutantOutcome;
  detail: string;
}

/** Ввод-вывод мутанта: всё — платформа (P51, `core-io-only-in-platform`); тесты отказов подменяют. */
export interface MutateIo {
  readBytes(path: string): Fact<Buffer>;
  writeBytes(path: string, bytes: Buffer): void;
  listDir(path: string): Fact<string[]>;
  ensureDir(path: string): void;
  remove(path: string): { removed: true } | { removed: false; reason: string };
  pidAlive(pid: number): boolean;
  /** `child` внутри `parent` по ключам диска (ссылки раскрыты, регистр по тому) — не по строкам. */
  inside(parent: string, child: string): boolean;
  /** `git rev-parse` в `cwd`; `undefined` — не рабочее дерево git или git не ответил. */
  gitRevParse(cwd: string, args: string[]): Promise<string | undefined>;
}

export interface RunPlanOptions {
  /** Корень путей плана (`file`, `spec`) и cwd раннера. */
  root: string;
  runner?: TestRunner;
  io?: MutateIo;
  /** Ждать конца чужой мутации в этом дереве до N мс; 0 — отказ сразу. */
  waitMs?: number;
  /** Строка хода прогона (CLI печатает, тесты собирают). */
  progress?: (line: string) => void;
  /** Идентичность журнала; по умолчанию — свой pid. Тесты подставляют чужой. */
  pid?: number;
  /** Запись `cmd` журнала mustfail. */
  cmd?: string;
  /**
   * Основа окружения детей-раннеров. Нет — базовое окружение платформы (имена ОС + PATH логин-шелла):
   * тесты мутанта пишет модель задачи, и окружение ядра (ключи, токены) им не положено. CLI передаёт
   * окружение своего шелла — оно и так у того, кто его запустил.
   */
  env?: NodeJS.ProcessEnv;
}

/** Отказ всего прогона (план не читается, дерево занято, файл не вернулся) — выход 2, не итог мутанта. */
export class MutateRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MutateRefusal';
  }
}

/** Журнал в формате mustfail (`<git-path mustfail>/journal-<pid>.json`): mustfail и mutation-guard читают его как свой. */
export interface MustfailJournal {
  pid: number;
  scope: string;
  started: string;
  cmd: string;
  files: Record<string, { backup: string; before: string; written: string[] }>;
}
