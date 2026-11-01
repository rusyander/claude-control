import type { CiClass, ForgeJob, ForgePipeline } from '@agentdeck/contracts/core/forge';

/**
 * Класс CI по прочитанным конвейерам (05:80, P30) — чистая функция без сети. `infra`: задание не
 * дошло до скрипта (не стартовало, умер раннер или под, срок ушёл на подготовку); `code`: скрипт
 * пошёл и покраснел. Машина CI не доказана (причина неизвестна, лог таймаута не прочёлся) —
 * красный судится кодом: ложный повтор на «машине» прятал бы настоящую поломку.
 * Судит ПОСЛЕДНИЙ конвейер головы ветки: красный первый и зелёный повтор — зелёный.
 */

export interface CiJobClass {
  id: string;
  name: string;
  class: CiClass;
}

export interface CiReading {
  class: CiClass;
  /** Конвейер, по которому вынесен класс; `null` — для головы ни одного. */
  pipelineId: string | null;
  headSha: string;
  jobs: CiJobClass[];
  /** Почему класс таков — по строке на упавшее или ждущее задание. */
  reasons: string[];
}

/** Класс одного задания по статусу и тому, стартовал ли скрипт. */
export function classifyJob(job: ForgeJob): CiClass {
  switch (job.status) {
    case 'success':
    case 'skipped':
      return 'green';
    case 'created':
    case 'pending':
    case 'running':
      return 'pending';
    // Отменённое задание код не судило: повтор решит, а не правка.
    case 'canceled':
      return 'infra';
    case 'failed':
      return job.scriptStarted === false ? 'infra' : 'code';
  }
}

/** Последний конвейер: позже создан; при равном времени — больший числовой id. */
function latest(pipelines: readonly ForgePipeline[]): ForgePipeline | undefined {
  let best: ForgePipeline | undefined;
  for (const p of pipelines) {
    if (
      !best ||
      p.createdAt > best.createdAt ||
      (p.createdAt === best.createdAt && Number(p.id) > Number(best.id))
    )
      best = p;
  }
  return best;
}

function jobless(pipeline: ForgePipeline): { class: CiClass; reason: string } {
  const own = classifyJob({
    id: pipeline.id,
    name: 'pipeline',
    status: pipeline.status,
    failureReason: null,
    startedAt: pipeline.createdAt,
    // Упал без единого задания — разбор конфигурации ветки: это код, не машина.
    scriptStarted: null,
  });
  return { class: own, reason: `pipeline ${pipeline.id} ${pipeline.status} without jobs` };
}

export function classifyCi(pipelines: readonly ForgePipeline[], headSha: string): CiReading {
  const pipeline = latest(pipelines.filter((p) => p.sha === headSha));
  if (!pipeline)
    return { class: 'none', pipelineId: null, headSha, jobs: [], reasons: ['no pipeline'] };
  if (pipeline.jobs.length === 0) {
    const own = jobless(pipeline);
    return { class: own.class, pipelineId: pipeline.id, headSha, jobs: [], reasons: [own.reason] };
  }
  const jobs = pipeline.jobs.map((j) => ({ id: j.id, name: j.name, class: classifyJob(j) }));
  const reasons = pipeline.jobs
    .filter((j) => classifyJob(j) !== 'green')
    .map((j) => `${j.name}: ${j.status}${j.failureReason ? ` (${j.failureReason})` : ''}`);
  return { class: overall(jobs), pipelineId: pipeline.id, headSha, jobs, reasons };
}

/** Красный код решён, даже пока остальные идут; машина — только когда всё кончилось. */
function overall(jobs: readonly CiJobClass[]): CiClass {
  for (const c of ['code', 'pending', 'infra'] as const)
    if (jobs.some((j) => j.class === c)) return c;
  return 'green';
}
