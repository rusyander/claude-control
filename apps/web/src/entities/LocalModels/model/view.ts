import {
  deviceGpu,
  fitModel,
  recommendModel,
  type CatalogModel,
  type InstalledModel,
  type LocalJob,
  type LocalJobKind,
  type LocalDevice,
  type LocalModelsInfo,
  type ModelBench,
  type ModelFit,
} from '@agentdeck/contracts/local-models';

/**
 * Что страница и подсказка под чатом показывают о моделях — одним расчётом.
 *
 * Расчёт «влезет ли и с какой скоростью» — общий с сервером (`fitModel` из
 * контрактов): сервер по нему ставит контекст при запуске, страница — пишет
 * оценку. Две копии формулы разошлись бы, и страница обещала бы контекст,
 * которого сервер не даст.
 */

const GB = 1024 ** 3;

/** Байты → гигабайты с одной цифрой после запятой. */
export function toGb(bytes: number): number {
  return Math.round((bytes / GB) * 10) / 10;
}

export function jobFor(
  info: LocalModelsInfo | undefined,
  kind: LocalJobKind,
  target: string,
): LocalJob | undefined {
  return info?.jobs.find((job) => job.kind === kind && job.target === target);
}

export function runningJob(
  info: LocalModelsInfo | undefined,
  kind: LocalJobKind,
  target: string,
): LocalJob | undefined {
  const job = jobFor(info, kind, target);
  return job?.state === 'running' ? job : undefined;
}

export interface CatalogRow {
  model: CatalogModel;
  fit: ModelFit;
  installed?: InstalledModel;
  /** Есть в системном Ollama — можно забрать без скачивания. */
  importable: boolean;
  recommended: boolean;
  job?: LocalJob;
  /** Замер снят не там, где модель считает сейчас, — где именно. */
  benchOn?: LocalDevice;
}

export function catalogRows(info: LocalModelsInfo): CatalogRow[] {
  // При счёте на процессоре подбор — по оперативной памяти: карта не участвует.
  const gpu = deviceGpu(info.hardware, info.device);
  const best = recommendModel(info.catalog.models, gpu, info.hardware.ramGb);
  const importable = new Set(info.importable.map((item) => item.tag));
  return info.catalog.models.map((model) => {
    const installed = info.installed.find((item) => item.tag === model.tag);
    const job = jobFor(info, 'model', model.tag);
    const benchOn = installed?.bench ? benchElsewhere(installed.bench, info.device) : undefined;
    return {
      model,
      fit: fitModel(model, gpu, info.hardware.ramGb),
      ...(installed ? { installed } : {}),
      importable: importable.has(model.tag),
      recommended: best?.model.tag === model.tag,
      ...(job ? { job } : {}),
      ...(benchOn ? { benchOn } : {}),
    };
  });
}

/** Установленные, которых нет в каталоге: поставлены руками или забраны из системы. */
export function foreignInstalled(info: LocalModelsInfo): InstalledModel[] {
  return info.installed.filter((item) => !item.known);
}

export type ChatHint =
  | { kind: 'download'; model: CatalogModel; fit: ModelFit; gpu: string }
  | { kind: 'busy'; model: CatalogModel; fit: ModelFit; gpu: string; job: LocalJob }
  | { kind: 'connect'; model: CatalogModel; fit: ModelFit; gpu: string };

/**
 * Подсказка под чатом: какую модель поставить на ЭТУ машину. Молчит, когда
 * локальная модель уже работает агентам, когда карта ничего годного агенту не
 * тянет (обещать «скачайте» без результата хуже, чем промолчать) и когда
 * другой контур активен — его человек выбрал сам.
 */
export function chatHint(info: LocalModelsInfo | undefined): ChatHint | undefined {
  if (!info || info.connect.active || info.connect.otherActive) return undefined;
  const gpu = deviceGpu(info.hardware, info.device);
  const best = recommendModel(info.catalog.models, gpu, info.hardware.ramGb);
  if (!best) return undefined;
  const base = { model: best.model, fit: best.fit, gpu: gpu?.name ?? '' };
  const job = runningJob(info, 'model', best.model.tag);
  if (job) return { kind: 'busy', ...base, job };
  if (info.installed.some((item) => item.tag === best.model.tag))
    return { kind: 'connect', ...base };
  return { kind: 'download', ...base };
}

/**
 * Где снят замер, если не там, где модель считает сейчас: замер видеокарты рядом
 * с оценкой для процессора без подписи читался бы как скорость процессора.
 * Совпадает — undefined, и строка пишет просто «Замерено».
 */
export function benchElsewhere(bench: ModelBench, device: LocalDevice): LocalDevice | undefined {
  const where = bench.device ?? (bench.gpu === 'cpu' ? 'cpu' : 'gpu');
  return where === device ? undefined : where;
}

/** Доля работы 0…1; неизвестный размер — undefined (полоса без числа). */
export function jobShare(job: LocalJob): number | undefined {
  if (job.totalBytes <= 0) return undefined;
  return Math.min(1, job.doneBytes / job.totalBytes);
}

/** Сколько осталось, секунд; без скорости — undefined. */
export function jobEtaSec(job: LocalJob): number | undefined {
  if (job.speed <= 0 || job.totalBytes <= 0) return undefined;
  return Math.max(0, Math.round((job.totalBytes - job.doneBytes) / job.speed));
}

/**
 * Где модель легла на деле — по ответу сервера (`/api/ps`), а не по выбору:
 * `gpuShare` — доля в видеопамяти, 0…1. Выбор «процессор» сервер может не
 * исполнить (Metal на Mac прятать нечем), и экран обязан это показать.
 */
export function placementOf(model: { vramBytes: number; sizeBytes: number }): {
  gpuShare: number;
} {
  if (model.sizeBytes <= 0) return { gpuShare: model.vramBytes > 0 ? 1 : 0 };
  return { gpuShare: Math.min(1, model.vramBytes / model.sizeBytes) };
}

/**
 * Модель для «Claude Code на локальной модели»: уже включённая, иначе та, что
 * отдана агентам, иначе рекомендованная из скачанных, иначе первая скачанная
 * из каталога. Нет ни одной — галочке включать нечего.
 */
export function claudeModelOf(info: LocalModelsInfo): string {
  if (info.claude.model) return info.claude.model;
  if (info.connect.model) return info.connect.model;
  const installed = new Set(info.installed.map((item) => item.tag));
  const rows = catalogRows(info).filter((row) => installed.has(row.model.tag));
  return (rows.find((row) => row.recommended) ?? rows[0])?.model.tag ?? '';
}
