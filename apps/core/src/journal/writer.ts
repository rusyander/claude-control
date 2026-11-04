import { join } from 'node:path';
import { z } from 'zod';
import {
  actorSchema,
  isTelemetryKind,
  JOURNAL_LINE_MAX_BYTES,
  JOURNAL_VERSION,
  type JournalKind,
  type JournalLine,
} from '@agentdeck/contracts/core/journal';
import { uuidv7 } from '@agentdeck/contracts/core/ids';
import { openAppendLog, type AppendLog } from '../platform/safe-io/append-log.ts';
import { writeFileAtomic } from '../platform/safe-io/atomic-write.ts';
import { pathExists } from '../platform/safe-io/files.ts';
import { chainHash, issueText, maskData, sha256OfText, validateData } from './line.ts';
import {
  JournalDurabilityError,
  JournalInputError,
  LeaseLostError,
  TASK_FILES,
  type AppendInput,
  type JournalClock,
  type MaskFn,
} from './journal.types.ts';

/**
 * Запись в журнал задачи (01 §Journal). Единственное место, где у события появляются `seq`,
 * `at`, `mono` и `bootId` (P09). Порядок одной записи:
 *   строгая проверка входа → аренда ещё наша → маска секретов → строгая схема данных вида
 *   (отказ → `journal.rejected.jsonl`, не молча) → штамп → строка ≤ 64 КБ (больше — данные в
 *   артефакт по sha256) → один `write` → fsync до возврата для всего, кроме телеметрии
 *   (телеметрия — пачкой, fsync ≤ 1 с) → цепочка хешей.
 */

const inputSchema = z.strictObject({
  kind: z.string().min(1),
  actor: actorSchema,
  data: z.unknown(),
  unitId: uuidv7.optional(),
  stepId: uuidv7.optional(),
  sessionId: uuidv7.optional(),
  cmdId: uuidv7.optional(),
  cause: z.number().int().positive().optional(),
});

export const TELEMETRY_FSYNC_MS = 1_000;

export interface WriterOptions {
  taskId: string;
  clock: JournalClock;
  mask: MaskFn;
  nextSeq: number;
  lastHash: string;
  /** Аренда ещё наша? Проверяется перед каждой записью: писатель один (P74). */
  holdsLease: () => boolean;
  /** Подмена таймера пачки телеметрии — для тестов. */
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  /**
   * Строка отвергнута (этап 8, сигнал `journal-rejected`): зовётся, когда отказ уже лежит в
   * `journal.rejected.jsonl`, и до броска `JournalInputError`. Сбой крючка отказ не подменяет;
   * запись в журнал изнутри крючка допустима — писатель в этот миг ничего не сдвинул.
   */
  onRejected?: (rejection: { kind: string; issues: string[] }) => void;
}

export interface JournalWriter {
  append<K extends JournalKind>(input: AppendInput<K>): JournalLine<K>;
  readonly lastHash: string;
  readonly nextSeq: number;
  /** Сколько fsync было — для теста политики долговечности. */
  readonly fsyncCount: number;
  /**
   * Отставание долговечности для `/v1/health` (07): сколько мс (по `mono` часов журнала —
   * прыжок стенных часов его не искажает) самая старая строка лежит в файле без fsync; 0 — всё
   * записанное на диске. Упавший отложенный fsync не сбрасывает его: отставание растёт и видно.
   */
  journalLagMs(): number;
  close(): void;
}

function realTimer(fn: () => void, ms: number): { cancel(): void } {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return { cancel: () => clearTimeout(handle) };
}

export function openWriter(dir: string, options: WriterOptions): JournalWriter {
  const log: AppendLog = openAppendLog(join(dir, TASK_FILES.journal));
  const setTimer = options.setTimer ?? realTimer;
  let nextSeq = options.nextSeq;
  let lastHash = options.lastHash;
  let fsyncCount = 0;
  let pending: { cancel(): void } | undefined;
  let rejectedLog: AppendLog | undefined;
  /** Упавший fsync: писатель закрыт для записей до переоткрытия задачи (ревью M5). */
  let failed: unknown;
  /** `mono` самой старой строки без fsync. */
  let unsyncedMono: number | undefined;

  const sync = (): void => {
    pending?.cancel();
    pending = undefined;
    log.sync();
    fsyncCount += 1;
    unsyncedMono = undefined;
  };
  // Отложенный fsync телеметрии идёт из таймера: брошенное там уронило бы процесс (ревью M4).
  // Отказ запоминается — следующая запись получит его как `JournalDurabilityError`.
  const deferredSync = (): void => {
    try {
      sync();
    } catch (error) {
      failed ??= error;
    }
  };

  const reject = (input: unknown, issues: string[]): never => {
    rejectedLog ??= openAppendLog(join(dir, TASK_FILES.rejected));
    const stamp = options.clock.stamp();
    // Отвергнутое тоже проходит маску: секрет не должен лечь на диск и через этот файл.
    const safe = maskData(input, options.mask).data;
    const entry = { rejectedAt: stamp.at, bootId: options.clock.bootId, issues, input: safe };
    rejectedLog.append(Buffer.from(`${JSON.stringify(entry)}\n`));
    rejectedLog.sync();
    const kind = (input as { kind?: unknown } | null)?.kind;
    try {
      options.onRejected?.({ kind: typeof kind === 'string' && kind ? kind : '(input)', issues });
    } catch {
      // Наблюдатель не может подменить отказ своим сбоем: вызывающий получит именно отказ.
    }
    throw new JournalInputError(issues);
  };

  return {
    get lastHash() {
      return lastHash;
    },
    get nextSeq() {
      return nextSeq;
    },
    get fsyncCount() {
      return fsyncCount;
    },
    journalLagMs() {
      if (unsyncedMono === undefined) return 0;
      return Math.max(0, options.clock.stamp().mono - unsyncedMono);
    },
    append<K extends JournalKind>(input: AppendInput<K>): JournalLine<K> {
      const shape = inputSchema.safeParse(input);
      if (!shape.success) {
        return reject(
          input,
          shape.error.issues.map((i) => issueText(i, '(input)')),
        );
      }
      if (!options.holdsLease()) throw new LeaseLostError(options.taskId);
      if (failed !== undefined) throw new JournalDurabilityError(options.taskId, undefined, failed);
      const masked = maskData(input.data, options.mask);
      const issues = validateData(input.kind, masked.data);
      if (issues.length) return reject({ ...input, data: masked.data }, issues);

      const stamp = options.clock.stamp();
      const line = {
        v: JOURNAL_VERSION,
        seq: nextSeq,
        at: stamp.at,
        mono: stamp.mono,
        bootId: options.clock.bootId,
        taskId: options.taskId,
        ...(input.unitId ? { unitId: input.unitId } : {}),
        ...(input.stepId ? { stepId: input.stepId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        kind: input.kind,
        actor: input.actor,
        ...(input.cmdId ? { cmdId: input.cmdId } : {}),
        ...(input.cause ? { cause: input.cause } : {}),
        ...(masked.count > 0 ? { masked: masked.count } : {}),
        data: masked.data,
      };
      let text = JSON.stringify(line);
      if (Buffer.byteLength(text) + 1 > JOURNAL_LINE_MAX_BYTES) {
        // Большие данные — в артефакт по содержимому; строка несёт ссылку (одна строка ≤ 64 КБ).
        const payload = JSON.stringify(masked.data);
        const sha = sha256OfText(payload);
        const artifact = join(dir, TASK_FILES.artifacts, `${sha}.json`);
        if (!pathExists(artifact)) writeFileAtomic(artifact, payload);
        text = JSON.stringify({
          ...line,
          data: null,
          dataRef: { sha256: sha, bytes: Buffer.byteLength(payload) },
        });
      }
      try {
        log.append(Buffer.from(`${text}\n`, 'utf8'));
      } catch (error) {
        // Журнал дописывания откатил частичную строку: файл как до записи, seq не тронут.
        throw new JournalDurabilityError(options.taskId, undefined, error);
      }
      // Строка в файле — seq и цепочка идут вперёд ДО fsync: упавший fsync не должен оставить
      // строку на диске без шага seq (иначе следующая запись повторит seq, журнал не читается).
      lastHash = chainHash(lastHash, text);
      nextSeq += 1;
      const written = line as unknown as JournalLine<K>;
      unsyncedMono ??= stamp.mono;
      if (isTelemetryKind(input.kind)) {
        pending ??= setTimer(deferredSync, TELEMETRY_FSYNC_MS);
      } else {
        try {
          sync();
        } catch (error) {
          failed = error;
          throw new JournalDurabilityError(options.taskId, written, error);
        }
      }
      return written;
    },
    close() {
      pending?.cancel();
      pending = undefined;
      log.close();
      rejectedLog?.close();
    },
  };
}
