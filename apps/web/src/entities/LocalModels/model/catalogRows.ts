import type {
  CatalogModel,
  ChoiceFit,
  ChoiceRecommendation,
  ChoiceOption,
  ModelFit,
  InstalledFile,
  InstalledModel,
  LocalJob,
  LocalDevice,
  LocalModelsInfo,
  ModelQuant,
} from '@agentdeck/contracts/local-models';
import {
  benchStale,
  contextOptions,
  deviceGpu,
  fitChoice,
  fitModel,
  quantOptions,
  recommendChoice,
  recommendModel,
  resolveChoice,
  withInstalledQuant,
} from '@agentdeck/contracts/local-models';
import { jobFor } from './jobFor';
import { benchElsewhere } from './benchElsewhere';
import { orderCatalogRows } from './catalogOrder';

export interface CatalogRow {
  /** Модель каталога; у модели с файлом из Ollama в списке квантований есть и он. */
  model: CatalogModel;
  /** Подбор под карту без выбора человека: по нему «Рекомендуем» и годность агенту по умолчанию. */
  fit: ModelFit;
  installed?: InstalledModel;
  /** Есть в хранилище Ollama — можно забрать без скачивания. */
  importable: boolean;
  recommended: boolean;
  job?: LocalJob;
  /** Замер снят не там, где модель считает сейчас, — где именно. */
  benchOn?: LocalDevice;
  /** Выбор в селекторах: сохранённое человеком или подбор. */
  choice: { quant: string; context: number; allowPartial: boolean };
  /** Как лягут ВЫБРАННЫЕ квантование и окно на память, свободную сейчас. */
  choiceFit: ChoiceFit;
  /** Варианты селекторов: каждый пересчитан под выбор в соседнем. */
  quantOptions: ChoiceOption<string>[];
  contextOptions: ChoiceOption<number>[];
  /** Выбранное квантование (размер файла) — нет, если это уже не квантование модели. */
  quant?: ModelQuant;
  /** Файл выбранного квантования уже на диске. */
  quantInstalled: boolean;
  /** Квантования, которые на диске. */
  installedQuants: string[];
  /** Скачанные файлы с размером и тем, что вернёт удаление; `loaded` — его держит сервер моделей. */
  downloaded: DownloadedFile[];
  /**
   * Что рекомендуется на этой машине (по доступной сейчас памяти): квантование и окно, либо «ничего не лезет».
   * Пересчитывается с каждым опросом — свободная память меняется.
   */
  recommendation: ChoiceRecommendation;
  /** Считается по видеокарте (иначе по оперативной памяти). */
  onGpu: boolean;
  /** Перезапуск сервера с новыми настройками, идущий сейчас, или его ошибка. */
  serverJob?: LocalJob;
  /** Замер снят при другом окне или квантовании (или с чем — не записано). */
  benchStale?: 'other' | 'unknown';
}

/** Скачанный файл строки: держит ли его сервер моделей прямо сейчас (такой удалить нельзя). */
export interface DownloadedFile extends InstalledFile {
  loaded: boolean;
}

export function catalogRows(info: LocalModelsInfo): CatalogRow[] {
  // При счёте на процессоре подбор — по оперативной памяти: карта не участвует.
  const gpu = deviceGpu(info.hardware, info.device);
  const ram = info.hardware.ramGb;
  const best = recommendModel(info.catalog.models, gpu, ram);
  const importable = new Set(info.importable.map((item) => item.tag));
  const server = info.server?.running ? info.server : undefined;
  const rows = info.catalog.models.map((source): CatalogRow => {
    const installed = info.installed.find((item) => item.tag === source.tag);
    const model = withInstalledQuant(source, installed);
    const job = jobFor(info, 'model', model.tag);
    const serverJob = jobFor(info, 'server', model.tag);
    const benchOn = installed?.bench ? benchElsewhere(installed.bench, info.device) : undefined;
    const stored = info.choices?.[model.tag];
    const choice = resolveChoice(model, gpu, ram, stored, installed?.quant);
    const installedQuants = installed?.quants ?? (installed?.quant ? [installed.quant] : []);
    const stale = installed?.bench ? benchStale(installed.bench, choice) : undefined;
    const quant = model.quants.find((item) => item.id === choice.quant);
    return {
      model,
      fit: fitModel(model, gpu, ram),
      ...(installed ? { installed } : {}),
      importable: importable.has(model.tag),
      recommended: best?.model.tag === model.tag,
      ...(job ? { job } : {}),
      ...(benchOn ? { benchOn } : {}),
      choice,
      choiceFit: fitChoice(model, gpu, ram, choice, choice.allowPartial),
      quantOptions: quantOptions(model, gpu, ram, choice.context, choice.allowPartial),
      contextOptions: contextOptions(model, gpu, ram, choice.quant, choice.allowPartial),
      ...(quant ? { quant } : {}),
      quantInstalled: installedQuants.includes(choice.quant),
      installedQuants,
      downloaded: (installed?.files ?? []).map((file) => ({
        ...file,
        loaded: server?.model === model.tag && server.quant === file.quant,
      })),
      recommendation: recommendChoice(model, gpu, ram),
      onGpu: gpu !== undefined,
      ...(serverJob ? { serverJob } : {}),
      ...(stale ? { benchStale: stale } : {}),
    };
  });
  return orderCatalogRows(rows);
}
