import type {
  CatalogModel,
  ModelFit,
  InstalledModel,
  LocalJob,
  LocalDevice,
  LocalModelsInfo,
} from '@agentdeck/contracts/local-models';
import { deviceGpu, recommendModel, fitModel } from '@agentdeck/contracts/local-models';
import { jobFor } from './jobFor';
import { benchElsewhere } from './benchElsewhere';

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
