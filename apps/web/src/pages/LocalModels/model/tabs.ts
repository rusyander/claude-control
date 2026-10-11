import type { IconName } from '@shared/ui/icon';

/**
 * Вкладки раздела «Локальные модели». Порядок — путь человека: что за машина
 * и есть ли сервер моделей, потом какую модель взять и скачать, последним —
 * отдать её агентам. `id` попадает в адрес (`/local-models?tab=…`).
 */
export const LOCAL_MODELS_TABS = ['hardware', 'models', 'agents'] as const;

export type LocalModelsTabId = (typeof LOCAL_MODELS_TABS)[number];

export const LOCAL_MODELS_TAB_ICONS: Record<LocalModelsTabId, IconName> = {
  hardware: 'server',
  models: 'search',
  agents: 'groups',
};
