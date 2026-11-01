import type { CheckEntry, CheckRecord } from '@agentdeck/contracts/core/records';
import type { HeartbeatAnswer } from '../queue/queue.types.ts';

/** Что исполнить: argv уже развёрнут (`argv.ts`), окружение — пин профиля задачи целиком. */
export interface RunSpec {
  checkRunId: string;
  taskId: string;
  entry: CheckEntry;
  argv: string[];
  /** Абсолютный cwd внутри копии (`copyDir` + `entry.cwd`). */
  cwd: string;
  /** Полное окружение прогона (зона E: пин профиля); из окружения ядра не наследуется ничего. */
  env: Record<string, string>;
  /** Где завести временный каталог прогона (`<root>/<checkRunId>`), снимается после (P40). */
  tempRoot: string;
  /** learned p95 × 3 (`deadline.ts`); вышел — дерево снимается, вердикт `no-verdict(aborted)`. */
  deadlineMs: number;
}

/** Аренда слота, под которой идёт прогон: удар сердца на каждом такте (D§3.8). */
export interface RunLease {
  leaseId: string;
  beatMs: number;
  heartbeat(): HeartbeatAnswer;
}

export interface RunDeps {
  now(): number;
  /** Эпоха стенда задачи (зона F `verifier/stand`); сменилась за прогон — `no-verdict(stand)`. */
  standEpoch(taskId: string): Promise<number | null> | number | null;
  /** Остановка извне (пауза, удержание, отмена задачи) — дерево снимается, вердикт `aborted`. */
  signal?: AbortSignal;
  /** POSIX: сколько ждать после TERM (тестам — короче). */
  graceMs?: number;
}

/** Чем кончился прогон. `exit` — сам вышел; остальное — его сняли или не запустили. */
export type RunEnd = 'exit' | 'deadline' | 'aborted' | 'lease-lost' | 'spawn-failed';

export interface RunResult {
  end: RunEnd;
  exit: number | null;
  signal: string | null;
  ms: number;
  log: string;
  logBytes: number; // всего байт вывода, включая срезанное
  truncated: boolean;
  failing: CheckRecord['failing'];
  passing?: CheckRecord['passing'];
  /** Упавших по итогу раннера (A1r2-F04); нет — итог не прочитан. */
  failedCount?: number;
  standEpoch: number | null;
  standMoved: boolean;
  /** Итог своего исполнителя класса (migration/contract, зона F) — ложится в запись под подпись. */
  classOutcome?: NonNullable<CheckRecord['classOutcome']>;
  /** Остановка дерева оставила процессы или не доказана — названо, не скрыто (P40). */
  residual?: string;
  /** Временный каталог прогона снят и перечитан (P40); иначе причина. */
  temp: { removed: true } | { removed: false; reason: string };
  reason?: string;
}
