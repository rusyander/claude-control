import { randomUUID } from 'node:crypto';
import type { LocalJob, LocalJobKind } from '@agentdeck/contracts/local-models';
import { codeOf } from '../../lib/server-text/server-text.ts';

/**
 * Долгие работы раздела — загрузка сервера, модели, Qwen Code — с прогрессом.
 *
 * Живут на сервере, а не на странице: закрытая вкладка загрузку не обрывает,
 * новая вкладка и телефон видят ту же полосу. Одна работа на цель: вторая
 * кнопка «Скачать» той же модели возвращает идущую, а не заводит вторую
 * загрузку тех же гигабайт.
 */

/** Окно, по которому считается скорость: мгновенная скачет, средняя с начала врёт после паузы. */
const SPEED_WINDOW_MS = 5000;
/** Сколько помнить законченные работы — чтобы страница успела показать «готово» и ошибку. */
const KEEP_FINISHED = 20;

interface Sample {
  at: number;
  bytes: number;
}

export interface JobHandle {
  job: LocalJob;
  signal: AbortSignal;
  progress(update: { phase?: string; doneBytes?: number; totalBytes?: number }): void;
}

export class LocalJobs {
  private readonly jobs = new Map<string, LocalJob>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly samples = new Map<string, Sample[]>();
  private readonly now: () => number;
  private readonly onChange: () => void;

  constructor(options: { now?: () => number; onChange?: () => void } = {}) {
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange ?? (() => {});
  }

  list(): LocalJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  find(kind: LocalJobKind, target: string): LocalJob | undefined {
    return [...this.jobs.values()].find(
      (job) => job.kind === kind && job.target === target && job.state === 'running',
    );
  }

  /**
   * Запустить работу. Уже идущая на ту же цель возвращается как есть: двойной
   * щелчок не должен качать одно и то же дважды в один каталог.
   */
  start(kind: LocalJobKind, target: string, work: (handle: JobHandle) => Promise<void>): LocalJob {
    const running = this.find(kind, target);
    if (running) return running;
    const controller = new AbortController();
    const job: LocalJob = {
      id: randomUUID(),
      kind,
      target,
      state: 'running',
      phase: 'start',
      doneBytes: 0,
      totalBytes: 0,
      speed: 0,
      startedAt: new Date(this.now()).toISOString(),
    };
    this.jobs.set(job.id, job);
    this.controllers.set(job.id, controller);
    this.samples.set(job.id, []);
    const handle: JobHandle = {
      job,
      signal: controller.signal,
      progress: (update) => this.progress(job, update),
    };
    void work(handle).then(
      () => this.finish(job, controller.signal.aborted ? 'cancelled' : 'done'),
      (error: unknown) =>
        this.finish(job, controller.signal.aborted ? 'cancelled' : 'failed', error),
    );
    this.onChange();
    return job;
  }

  cancel(id: string): boolean {
    const controller = this.controllers.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** Отменить всё идущее — при остановке панели. Докачка продолжит с места. */
  cancelAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
  }

  private progress(
    job: LocalJob,
    update: { phase?: string; doneBytes?: number; totalBytes?: number },
  ): void {
    if (update.phase !== undefined && update.phase !== job.phase) {
      job.phase = update.phase;
      // Новый этап — новая скорость: проверка контрольной суммы не «качает» со
      // скоростью загрузки.
      this.samples.set(job.id, []);
    }
    if (update.totalBytes !== undefined) job.totalBytes = update.totalBytes;
    if (update.doneBytes !== undefined) {
      job.doneBytes = update.doneBytes;
      const now = this.now();
      const samples = (this.samples.get(job.id) ?? []).filter((s) => now - s.at <= SPEED_WINDOW_MS);
      samples.push({ at: now, bytes: update.doneBytes });
      this.samples.set(job.id, samples);
      const first = samples[0];
      const span = first ? now - first.at : 0;
      job.speed =
        first && span > 0 ? Math.max(0, ((update.doneBytes - first.bytes) * 1000) / span) : 0;
    }
    this.onChange();
  }

  private finish(job: LocalJob, state: LocalJob['state'], error?: unknown): void {
    job.state = state;
    job.speed = 0;
    job.finishedAt = new Date(this.now()).toISOString();
    if (error !== undefined && state === 'failed') {
      job.error = error instanceof Error ? error.message : String(error);
      const coded = codeOf(error);
      if (coded.messageCode) {
        job.errorCode = coded.messageCode;
        if (coded.params) job.errorParams = coded.params as Record<string, string | number>;
      }
    }
    this.controllers.delete(job.id);
    this.samples.delete(job.id);
    const finished = this.list().filter((item) => item.state !== 'running');
    for (const old of finished.slice(KEEP_FINISHED)) this.jobs.delete(old.id);
    this.onChange();
  }
}
