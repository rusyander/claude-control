import type { FastifyInstance } from 'fastify';
import { newId } from '../../lib/ids/uuidv7.ts';
import { registerSessionCapture } from '../../api/session-capture.ts';
import type { CaptureEntry } from '../../api/session-capture.types.ts';
import { callerAncestry } from '../../adapters/cli-ancestry.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import { readCaptureToken } from '../../platform/capture-shim.ts';
import { commonDirSync, scratchIndexTree, workTreeOf } from '../../platform/git.ts';
import type { CoreHomeLayout } from '../../platform/core-home.ts';
import { osProcessTable, type ProcessTableSource } from '../../platform/process-table.ts';
import { createPseudoTasks } from '../../policy/session-tokens/pseudo-tasks.ts';
import type { SessionTokens } from '../../policy/session-tokens/session-tokens.ts';
import { ingestSpool, type SpoolSink } from '../../verifier/spool/ingest.ts';
import { captureEntry } from './capture-entry.ts';
import type { QueueWiring } from './queue.ts';
import { storeSpoolSink } from './spool-sink.ts';

/**
 * Зона D (захват прогонов сессии: прокладка, обёртки, `/v1/session/capture`). Сборка ленивая:
 * раскладка дома читается только при регистрации ручек — тест волны 0 строит её на пустой.
 *
 * Волна 2: вопрос захвата идёт в единственный вход проверок зоны C (`captureEntry` →
 * `requestCheck` с `exec: 'caller'`), очередь `spool/` — в хранилище записей зоны A как
 * `unattended` (`storeSpoolSink`); обвязка очереди даётся из `index.ts` и строится лениво, при
 * первом вопросе. Без неё (тест волны 0) — 503 `check-entry-absent` и файлы очереди ждут с
 * причиной. Образы CLI для псевдозадач — `images` переходников (`index.ts`), имя образа — колонка
 * таблицы процессов ОС (A2-F02); предок без образа CLI (CLI из npm под `node`, снимок без имени) не
 * опознаётся — проверка идёт вне очереди и названа.
 */

export interface CaptureWiringDeps {
  registry: TaskRegistry;
  layout: CoreHomeLayout;
  /** Обвязка зоны C: из неё вход захвата и забор очереди, если они не даны явно. */
  queue?: QueueWiring;
  entry?: CaptureEntry;
  sink?: SpoolSink;
  table?: ProcessTableSource;
  images?: () => readonly string[];
  note?: (event: string, data: Record<string, unknown>) => void;
}

export interface CaptureWiring {
  /** Ручки захвата на API ядра; зовёт `boot-api.ts` рядом с `registerSessionTools`. */
  register(app: FastifyInstance, tokens: SessionTokens): void;
}

const STORE_ABSENT: SpoolSink = {
  take: async () => ({ refused: 'check queue not wired: the record store is unreachable' }),
};

export function captureWiring(deps?: CaptureWiringDeps): CaptureWiring {
  return {
    register(app, tokens) {
      if (!deps) throw new Error('capture wiring built without registry and layout');
      const table = deps.table ?? osProcessTable();
      const pseudo = createPseudoTasks({
        tasksDir: deps.layout.tasks,
        ancestry: async (caller) => {
          const rows = await table.read();
          if (!('value' in rows)) return rows;
          // Строка вызывающего сверена с названным им стартом (B2r2-F04).
          return callerAncestry(rows.value, caller);
        },
        images: deps.images ?? (() => []),
        newId,
        now: Date.now,
      });
      const queue = deps.queue;
      const sink =
        deps.sink ??
        (queue
          ? storeSpoolSink({
              queue,
              workTree: (dir) => workTreeOf(dir),
              treeId: (top) => scratchIndexTree(top),
            })
          : STORE_ABSENT);
      const entry =
        deps.entry ??
        (queue
          ? captureEntry({
              queue,
              registry: deps.registry,
              workTree: (dir) => workTreeOf(dir),
              commonDir: commonDirSync,
              now: Date.now,
              ...(deps.note ? { note: deps.note } : {}),
            })
          : undefined);
      registerSessionCapture(app, {
        registry: deps.registry,
        tokens,
        captureToken: () => readCaptureToken(deps.layout.root),
        ...(entry ? { entry } : {}),
        pseudo,
        drainSpool: () => ingestSpool(deps.layout.spool, sink),
        ...(deps.note ? { note: deps.note } : {}),
      });
    },
  };
}
