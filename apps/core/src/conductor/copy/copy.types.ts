import type { Fact } from '@agentdeck/contracts/core/facts';
import type { RepoPath, Stack } from '@agentdeck/contracts/core/records';

/**
 * Типы настройки копии (04:97-99, G7): копия от закреплённой базы, локальный слой по списку,
 * зависимости командой проекта, откат переписанных lock-файлов, длинные пути, настоящий cwd.
 * Что осталось за бортом — называется на единице; провал не блокирует молча (решение `copy-setup`).
 */

/** Дописанное человеком к встроенным спискам зеркала. Пусто — только встроенное. */
export interface MirrorSettings {
  include: string[];
  exclude: string[];
}

export type MirrorFlag = 'skip-worktree' | 'assume-unchanged';

export interface FlaggedEntry {
  path: RepoPath;
  flag: MirrorFlag;
}

/** Четыре списка от git основной копии + обход свёрнутых каталогов (чистая часть зеркала). */
export interface MirrorInput {
  flagged: FlaggedEntry[];
  /** `ls-files --others --ignored --directory`: каталоги с «/» на конце. */
  ignored: string[];
  /** Неотслеживаемое и не игнорируемое: git о нём молчит обоим спискам выше. */
  others: string[];
  /** Отслеживаемое с местными правками: в чекауте копии лежала бы версия коммита. */
  modified: string[];
  settings: MirrorSettings | undefined;
  listDir(dir: RepoPath): RepoPath[];
}

export interface MirrorPlan {
  files: RepoPath[];
  flagged: FlaggedEntry[];
  /** Игнорируемое верхнего уровня, что в списке не значится. */
  unlisted: RepoPath[];
  /** Окружение сборки верхнего уровня: в копию не идёт никогда, ставит установка. */
  built: RepoPath[];
}

export interface MirrorSkip {
  path: RepoPath;
  why: string;
}

export interface MirrorReport {
  mirrored: RepoPath[];
  skipped: MirrorSkip[];
  unlisted: RepoPath[];
  built: RepoPath[];
  /** Флаг git в копии не встал — файл есть, но git покажет его изменённым. */
  flagsFailed: RepoPath[];
  /** Повторное зеркало (`newerOnly`): файл копии не старее основной — не переписан. */
  kept?: RepoPath[];
}

/** Один шаг установки: команда проекта в корне стека. */
export interface InstallStep {
  stack: Stack;
  /** Корень стека от корня копии ('' — корень). */
  root: RepoPath;
  command: string;
  args: string[];
  /** Откуда команда: менеджер профиля, lock-файл, настройка человека. */
  why: string;
}

export interface InstallPlan {
  steps: InstallStep[];
  /** Стек, для которого команды нет (python без lock-файла, JVM, .NET) — назван, не молчит. */
  notes: { subject: string; why: string }[];
  /** Профиль не прочитался — команды неизвестны: установка не сделана, и это провал этапа. */
  unread?: string;
}

export interface InstallRun {
  step: InstallStep;
  /** null — процесс не дал кода (остановлен по сроку, отказ запуска). */
  exit: number | null;
  timedOut: boolean;
  /** Запуск отказан до старта (нет программы, cwd длиннее Win32). */
  refused?: string;
  ms: number;
  logFile: string;
  /** Хвост лога без шума установщиков, ≤ LOG_TAIL_MAX знаков. */
  tail: string;
  /**
   * Первая строка ошибки по ВСЕМУ выводу (`runInstall` ловит её в потоке, мимо потолка 64 КБ), не
   * по хвосту: у длинного дерева ошибок npm начало в хвост не влезает, а из хвоста «первой» вышла
   * бы его середина (F-173).
   */
  firstError?: string;
  /** Остаток дерева после остановки по сроку (не снят доказанно). */
  leftover?: string;
}

export type SetupStage = 'create' | 'mirror' | 'env' | 'install' | 'lockfiles' | 'longpaths';

export type LeftBehindKind =
  | 'copy'
  | 'unlisted'
  | 'build-env'
  | 'mirror-skip'
  | 'git-flag'
  | 'env-var'
  | 'env'
  | 'install'
  | 'install-note'
  | 'lockfiles'
  | 'longpaths';

/** Что копия не получила — строка на единице (04:98-99). */
export interface LeftBehind {
  kind: LeftBehindKind;
  subject: string;
  why: string;
}

export interface EnvChangeView {
  file: RepoPath;
  name: string;
  action: 'rewritten' | 'removed';
  why: string;
}

/** Входы судьи `copy-setup`: факты каждого этапа как они прочитались. */
export interface CopySetupInput {
  mirror: Fact<MirrorReport>;
  env: Fact<EnvChangeView[]>;
  plan: InstallPlan;
  installs: InstallRun[];
  /** Откаченные lock-файлы и манифесты подготовки. */
  reverted: Fact<RepoPath[]>;
  /** `on` — ключ прочитан назад из конфига репозитория; `not-needed` — не Windows. */
  longPaths: Fact<'on' | 'not-needed'>;
  /** Копия оценки (G6): установка посчитана, но отложена до первого шага работы. */
  deferred?: true;
}

/** Копия не выложена (база не прочиталась, `worktree add` отказал): настраивать нечего. */
export interface CopyCreateFailed {
  createFailed: string;
}

export type CopySetupVerdict = 'ready' | 'ready-with-gaps' | 'failed';

export interface CopySetupDecision {
  verdict: CopySetupVerdict;
  /** Окружение копии подготовлено ядром: установка прошла и `.env` переписан (04:13, G13). */
  envPrepared: boolean;
  leftBehind: LeftBehind[];
  /** Первый провал: этап, хвост лога, первая строка ошибки — уходит в шаг (04:99). */
  failure?: { stage: SetupStage; tail: string; firstError?: string };
  /** Строки для задания модели — английские (решение D-E): что подготовлено и что нет. */
  brief: string[];
  /** Установка отложена (копия оценки): её доставит первый шаг, что правит копию. */
  installDeferred?: true;
}

/** Копия, выложенная действием `copy-create`. */
export interface CopyPlaced {
  /** Настоящий путь копии в длинной форме — он и cwd сессии. */
  dir: string;
  branch: string;
  /** База, закреплённая первой попыткой единицы (sha). */
  baseSha: string;
  /** HEAD копии, прочитанный при выкладке или при повторе поверх целой копии. */
  head: string;
  longPaths: Fact<'on' | 'not-needed'>;
}
