import { z } from 'zod';
import type { LocalModelsInfo } from '@agentdeck/contracts';
import { definePanelAction, type AnyPanelAction } from '../registry.ts';

/**
 * Раздел «Локальные модели» для агента панели — пока только чтение: что
 * стоит на машине, запущен ли сервер, к какому CLI подключено. Загрузки,
 * нагрузка на видеокарту, удаление и подключение — кнопки человека
 * (`human:` в реестре возможностей).
 */
const localModelsStatus = definePanelAction({
  name: 'local_models_status',
  section: 'local-models',
  risk: 'read',
  description:
    'Local models on this machine: GPU/RAM, runtime version, whether the model server runs and ' +
    'what it has loaded, installed models with benchmark, which CLI is connected. Read-only.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/local-models' }),
  shape: (_input, body) => {
    const data = body as LocalModelsInfo;
    return {
      hardware: {
        gpus: data.hardware.gpus,
        ramGb: data.hardware.ramGb,
        ...(data.hardware.diskFreeGb === undefined ? {} : { diskFreeGb: data.hardware.diskFreeGb }),
      },
      runtime: {
        source: data.runtime.source,
        version: data.runtime.version,
        outdated: data.runtime.outdated,
      },
      server: {
        running: data.server.running,
        loaded: data.server.loaded.map((item) => item.tag),
        ...(data.server.error ? { error: data.server.error } : {}),
      },
      installed: data.installed.map((model) => ({
        tag: model.tag,
        sizeBytes: model.sizeBytes,
        ...(model.bench ? { bench: model.bench } : {}),
      })),
      connect: data.connect,
      runningJobs: data.jobs.length,
    };
  },
  summary: 'journal-local-models-status',
});

export const LOCAL_MODELS_ACTIONS: readonly AnyPanelAction[] = [localModelsStatus];
