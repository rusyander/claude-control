import type {
  CatalogModel,
  ModelFit,
  LocalJob,
  LocalModelsInfo,
} from '@agentdeck/contracts/local-models';
import { deviceGpu, recommendModel } from '@agentdeck/contracts/local-models';
import { runningJob } from './runningJob';

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
