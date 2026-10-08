import type { ModelCatalogResponse } from '@agentdeck/contracts';

/**
 * Что показать про источник каталога: ключ строки и её подстановки.
 *
 * Отдельной функцией, потому что случаев четыре и путать их нельзя: каталог
 * контура, каталог models.dev, откат с названной причиной и «источник ни разу не
 * отвечал». Откат обязан назваться — подменённый список того, чем человек может
 * пользоваться, без объяснения читается как «модели пропали».
 */
export interface SourceLine {
  key: string;
  params: Record<string, string>;
  /** Откат: строка рисуется предупреждением, а не обычной подписью. */
  warning: boolean;
}

export function sourceLine(catalog: ModelCatalogResponse, date: string): SourceLine {
  if (catalog.fallback) {
    return {
      key: `models.fallback.${catalog.fallback}`,
      params: { platform: catalog.platformTitle ?? catalog.platformId ?? '' },
      warning: true,
    };
  }

  if (catalog.source === 'platform') {
    return {
      key: 'models.sourcePlatform',
      params: { platform: catalog.platformTitle ?? '', date },
      warning: false,
    };
  }

  if (catalog.source === 'none') return { key: 'models.noSource', params: {}, warning: false };

  return {
    key: 'models.source',
    params: { date, vendors: catalog.vendors.join(', ') },
    warning: false,
  };
}
