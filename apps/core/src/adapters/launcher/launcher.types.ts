import type { SessionStateDoc } from '@agentdeck/contracts/core/user-layer';
import type { Identity } from '../../session-host/protocol.ts';

/**
 * Типы запускающего (03 §Launcher). Ничего от конкретного CLI: переходник приносит команду,
 * argv и свои переменные, запускающий собирает окружение, разрешает исполняемый файл и
 * поднимает CLI через хост сессии.
 */

/** Переменные ядра, которые получает каждая сессия (F19) — для авторов хуков человека. */
export interface CoreSessionVars {
  taskId: string;
  stepId: string;
  stepKind: string;
  /** Адрес API ядра на loopback. */
  coreUrl: string;
  /** Токен сессии: только чтение + инструменты модели. */
  sessionToken: string;
  /**
   * Снимок `agentdeck state` на запуск (G8): шаг, требования, свои пути, обязательные проверки,
   * бюджеты. Нет — в `state.json` неполный снимок с причиной (`incomplete`), не выдуманные поля.
   */
  state?: SessionStateDoc;
}

/**
 * Окружение слоями: пин задачи < сессия (переходник: привязка адреса, пределы, свои флаги) <
 * ядро. Ничего не наследуется от процесса ядра.
 */
export interface EnvLayers {
  /** Пин задачи — окружение, закреплённое при старте задачи (PATH, локаль, дом). */
  pin: Record<string, string>;
  /** Переменные сессии от переходника. */
  session?: Record<string, string>;
  /** Файлы, которые node обязан подгрузить (`--require`, перехват проверок 03 §Process capture). */
  nodeRequires?: string[];
}

export interface LaunchInput {
  /** Каталог сессии в доме ядра (создаётся): хост, вывод, временный каталог, state.json. */
  dir: string;
  sessionId: string;
  /** Имя или путь исполняемого файла; разрешается здесь, до хоста. */
  command: string;
  args: string[];
  cwd: string;
  env: EnvLayers;
  core: CoreSessionVars;
  /** Каталоги поиска после PATH (данные переходника). */
  extraDirs?: string[];
  readyTimeoutMs?: number;
}

/** Что ушло в ОС — для `session.started` журнала (argv такой, каким его исполнили). */
export interface SpawnedFacts {
  /** Файл, который исполняет ОС (настоящий, не обёртка). */
  file: string;
  /** Полный argv после файла: префикс обёртки + аргументы переходника. */
  argv: string[];
  /** Что нашлось на диске под именем команды (обёртка или сам файл). */
  found: string;
  kind: string;
  /** Рабочий каталог — длинная настоящая форма. */
  cwd: string;
  /** Имена переменных окружения CLI (значения в журнал не идут: там ключи и токен). */
  envNames: string[];
}

export type LaunchOutcome =
  | {
      ok: true;
      dir: string;
      sessionId: string;
      host: Identity;
      /** Настоящий номер CLI + время старта (личность для остановки деревом). */
      child: Identity;
      spawned: SpawnedFacts;
      /** Временный каталог сессии (TMPDIR/TEMP/TMP). */
      tmpDir: string;
      statePath: string;
    }
  | { ok: false; reason: string; refused: boolean };

/** Вывод CLI с потолком: голова + хвост, середина выброшена и названа. */
export interface CappedArtifact {
  text: string;
  bytes: number;
  truncated: boolean;
}

export interface ArtifactCap {
  headBytes: number;
  tailBytes: number;
}

export type StopMode = 'soft' | 'tree';

export interface StopOutcome {
  /** Как кончился CLI: сам после закрытия stdin или снят деревом. */
  how: 'exited' | 'tree' | 'already-exited' | 'lost';
  residual: Identity[];
  /**
   * Остановка не доказана (снимок, поиск по метке или сверка не прочитаны) — причина от хоста.
   * Чистая остановка — пустой `residual` И нет этого поля.
   */
  unknown?: string;
  code?: number | null;
  reason?: string;
}

export interface RunOnceResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  reason?: string;
}
