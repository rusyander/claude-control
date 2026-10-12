import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { ComposeAction, ComposeJob } from '@agentdeck/contracts';
import type { DockerSpawn } from './docker.ts';

/**
 * Действия над стеком: одно на проект. Два «Поднять всё» подряд, или «Поднять»
 * поверх идущего «Удалить», дали бы гонку двух docker compose над одними
 * контейнерами — второй запрос получает отказ, пока первый не кончился.
 *
 * Последнее действие помнится и после конца: в хвосте его вывода причина
 * отказа («port is already allocated»), и человек должен успеть её прочитать.
 */

export class ComposeBusyError extends Error {
  readonly job: ComposeJob;

  constructor(job: ComposeJob) {
    super('compose-busy');
    this.job = job;
  }
}

/** Хвост вывода: сборка образа печатает тысячи строк, причина отказа — в последних. */
const TAIL_LINES = 200;
/** Сборка большого образа идёт минуты; дольше 15 — это зависание, а не работа. */
const JOB_TIMEOUT_MS = 15 * 60_000;

/** Общие флаги: без цветовых кодов и без перерисовки строк — вывод читается как текст. */
const GLOBAL_FLAGS = ['compose', '--ansi', 'never', '--progress', 'plain'];

export function composeArgs(action: ComposeAction, service?: string): string[] {
  const target = service ? [service] : [];
  switch (action) {
    case 'up':
      return [...GLOBAL_FLAGS, 'up', '-d', ...target];
    case 'stop':
      return [...GLOBAL_FLAGS, 'stop', ...target];
    case 'restart':
      return [...GLOBAL_FLAGS, 'restart', ...target];
    case 'down':
      return [...GLOBAL_FLAGS, 'down'];
    case 'down-volumes':
      return [...GLOBAL_FLAGS, 'down', '-v'];
  }
}

export function appendTail(current: string, chunk: string): string {
  const lines = (current + chunk.replace(/\r\n?/g, '\n')).split('\n');
  return lines.length > TAIL_LINES ? lines.slice(-TAIL_LINES).join('\n') : lines.join('\n');
}

interface Running {
  job: ComposeJob;
  kill?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class ComposeRegistry {
  private readonly jobs = new Map<string, Running>();
  private readonly spawnDocker: DockerSpawn;
  private readonly onFinish?: (projectPath: string, job: ComposeJob) => void;

  constructor(spawnDocker: DockerSpawn, onFinish?: (projectPath: string, job: ComposeJob) => void) {
    this.spawnDocker = spawnDocker;
    this.onFinish = onFinish;
  }

  jobOf(projectPath: string): ComposeJob | undefined {
    return this.jobs.get(resolve(projectPath))?.job;
  }

  /**
   * Начать действие. Сервис уже проверен вызывающим по `compose config`;
   * `down` и `down-volumes` идут над всем стеком — сервис для них не задают.
   */
  start(projectPath: string, cwd: string, action: ComposeAction, service?: string): ComposeJob {
    const key = resolve(projectPath);
    const current = this.jobs.get(key);
    if (current?.job.status === 'running') throw new ComposeBusyError(current.job);

    const scoped = action === 'down' || action === 'down-volumes' ? undefined : service;
    const job: ComposeJob = {
      id: randomUUID(),
      action,
      ...(scoped ? { service: scoped } : {}),
      status: 'running',
      startedAt: new Date().toISOString(),
      output: '',
    };
    const running: Running = { job };
    this.jobs.set(key, running);

    const child = this.spawnDocker(composeArgs(action, scoped), cwd);
    running.kill = () => child.kill();
    child.onOutput((chunk) => {
      job.output = appendTail(job.output, chunk);
    });
    running.timer = setTimeout(() => {
      job.output = appendTail(job.output, '\n[agentdeck] stopped after 15 minutes\n');
      child.kill();
    }, JOB_TIMEOUT_MS);
    running.timer.unref?.();
    child.onExit((code, missing) => {
      if (running.timer) clearTimeout(running.timer);
      running.kill = undefined;
      if (missing) job.output = appendTail(job.output, 'docker: command not found\n');
      job.status = code === 0 ? 'done' : 'failed';
      job.finishedAt = new Date().toISOString();
      job.output = job.output.trimEnd();
      this.onFinish?.(key, job);
    });
    return job;
  }

  /** Сервер панели выходит: идущие docker compose гасим, контейнеры остаются как есть. */
  stopAll(): void {
    for (const running of this.jobs.values()) {
      if (running.timer) clearTimeout(running.timer);
      running.kill?.();
    }
  }
}
