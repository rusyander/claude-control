import type { EngineInfo } from '@agentdeck/contracts/core/records';
import type { resolveExecutable } from './exec-resolve.ts';
import type { OsKind } from './os-kind.ts';
import type { ToolRun } from './run-tool.ts';

/** Движок контейнеров (04:126-127, 09:30, P58): чем говорить, с каким окружением. */

export interface EngineHandle {
  info: EngineInfo;
  /** Исполняемый файл CLI (docker / podman), найденный по PATH. */
  file: string;
  /** Аргументы перед своими (обёртка CLI, найденная резолвером). */
  prefix: string[];
  /** Полное окружение вызова; при `viaSocket` в нём `DOCKER_HOST` найденного сокета. */
  env: NodeJS.ProcessEnv;
  /** Свой запуск CLI — только тесты решений (`removeEphemeral` по меткам); по умолчанию `runTool`. */
  run?: EngineRun;
}

export type EngineRun = (
  file: string,
  args: readonly string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; acceptNonZero?: boolean; input?: string },
) => Promise<ToolRun>;

export interface EngineProbeOptions {
  env?: NodeJS.ProcessEnv;
  os?: OsKind;
  /** Известные сокеты после контекста CLI; по умолчанию — свои у каждой ОС (`knownSockets`). */
  sockets?: readonly string[];
  run?: EngineRun;
  resolve?: typeof resolveExecutable;
  /** Есть ли unix-сокет на диске (npipe не проверяется — пробуется сразу). */
  socketExists?: (path: string) => boolean;
  /** Свой таймер класса чтения — для теста отказов (P44). */
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}

/** Контейнер сервиса: всегда с меткой `claude.ephemeral=1` (её ставит `runContainer` сам). */
export interface ContainerSpec {
  image: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  /** Порты контейнера; публикуются на 127.0.0.1 со случайным портом хоста. */
  ports: number[];
  command?: string[];
}

export interface ContainerRow {
  id: string;
  name: string;
  state: string;
}

/** Снятие: `verified` — прочитано назад, `leak` — нет, `refused` — не наш контейнер, не тронут. */
export type EngineRelease = { verified: string } | { leak: string } | { refused: string };
