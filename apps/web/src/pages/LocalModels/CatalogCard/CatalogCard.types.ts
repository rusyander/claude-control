import type { LocalModelsInfo } from '@agentdeck/contracts/local-models';

export interface CatalogCardProps {
  info: LocalModelsInfo;
}

/** Что подтверждается к удалению: одно квантование, скачанная модель целиком, своя запись или обе вместе. */
export interface RemoveTarget {
  tag: string;
  /** Одно квантование; нет — модель целиком. */
  quant?: string;
  /** Квантование так, как оно названо на экране. */
  quantTitle?: string;
  /** Сколько места вернёт удаление, байт (у ссылки на файл Ollama — 0). */
  freesBytes: number;
  /** Скачанных квантований у модели. */
  count: number;
  custom: boolean;
  /** Одно квантование — ссылка на файл Ollama. */
  ollama: boolean;
}
