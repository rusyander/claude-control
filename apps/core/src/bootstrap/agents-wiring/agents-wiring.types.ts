import type { AgentsPort } from '../../api/agents.ts';
import type { ReleaseDeps } from '../../conductor/services/release.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import type { MaskFn } from '../../journal/journal.types.ts';
import type { CoreHomeLayout } from '../../platform/core-home.ts';
import type { LivenessProbe } from '../../platform/process-identity.ts';

export interface AgentsWiringDeps {
  layout: CoreHomeLayout;
  registry: TaskRegistry;
  mask: MaskFn;
  note: (event: string, data: Record<string, unknown>) => void;
  /** Часы сторожа зависания (активное время ядра: сон машины не считается тишиной вывода). */
  now?: () => number;
  /** Сколько вывод фоновой работы может стоять (по умолчанию `BG_HANG_AFTER_MS`). */
  hangAfterMs?: number;
  /** Шаг обхода сторожа фона, мс; `0` — обхода нет (только по строке конца задачи). */
  tickMs?: number;
  /** Жив ли процесс и его личность — проба ядра; нет — своя проба таблицы процессов ОС. */
  liveness?: Pick<LivenessProbe, 'isAlive' | 'identityOf'>;
  /** Снос процесса (для тестов); по умолчанию настоящий снос с чтением назад. */
  release?: ReleaseDeps;
}

/** Подстройки из кода загрузки (только тесты: раздела настроек нет). */
export type AgentsBootOptions = Pick<AgentsWiringDeps, 'hangAfterMs' | 'tickMs' | 'release'>;

export interface AgentsWiring {
  port(): AgentsPort | undefined;
  /** Один обход сторожа фона сейчас (тест и конец задачи); ответ — когда обход закончен. */
  sweep(): Promise<void>;
  stop(): Promise<void>;
}
