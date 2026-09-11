import type {
  ModelCatalogResponse,
  ModelInfo,
  ModelSource,
  PlatformStatus,
} from '@agentdeck/contracts';

/** Сколько моделей показываем до нажатия «показать все». */
export const VISIBLE_MODELS = 12;

/**
 * Что реально видно в карточке: у OpenAI полсотни моделей, и вываливать их
 * целиком в настройки незачем — свежие сверху, остальные по кнопке.
 */
export function visibleModels(models: ModelInfo[], expanded: boolean): ModelInfo[] {
  return expanded ? models : models.slice(0, VISIBLE_MODELS);
}

/**
 * Окно контекста человеческим числом: `1000000` → `1M`, `200000` → `200K`.
 * Пусто, если источник лимита не знает, — выдумывать нечего.
 */
export function formatContext(tokens: number | undefined): string {
  if (!tokens || tokens <= 0) return '';
  if (tokens >= 1_000_000) return `${round(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${round(tokens / 1_000)}K`;
  return String(tokens);
}

function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * Контуры, которые ГОДЯТСЯ в источники каталога.
 *
 * Годится не всякий: у выключенного и у бесключевого панель ничего не спросит,
 * и предлагать их в выпадающем списке значит предлагать выбрать поломку. Уже
 * ВЫБРАННЫЙ контур остаётся в списке даже негодным — иначе он молча пропадает
 * из поля, и человек не понимает, что вообще выбрано.
 */
export function platformSourceOptions(
  platforms: PlatformStatus[] | undefined,
  selectedId: string,
): PlatformStatus[] {
  return (platforms ?? []).filter(
    (status) => (status.platform.enabled && status.hasToken) || status.platform.id === selectedId,
  );
}

/** Можно ли вообще выбрать источником контур: хоть один готов или уже выбран. */
export function canUsePlatformSource(
  platforms: PlatformStatus[] | undefined,
  selectedId: string,
): boolean {
  return platformSourceOptions(platforms, selectedId).length > 0;
}

/**
 * Показывать ли строку «контур» в выборе источника.
 *
 * Годных контуров может не остаться уже ПОСЛЕ того, как источником выбран
 * контур: человек выключил его на своей странице, ничего не выбрав в «какой
 * контур». Убрать строку из списка в этот момент нельзя — поле показало бы
 * первый попавшийся вариант (models.dev) при сохранённом `platform`, то есть
 * соврало бы о том, что выбрано, прямо над предупреждением об откате.
 */
export function showsPlatformSource(ready: boolean, current: ModelSource): boolean {
  return ready || current === 'platform';
}

/**
 * Чем объяснить пустой список.
 *
 * Пусто у контура и пусто у models.dev — разные беды: первое значит «ключу не
 * выдано ни одной модели» (ответ контура, который сервер намеренно не
 * подменяет), второе — «источник не отвечал». Общая строка про «не ответил»
 * стояла бы прямо под подписью «источник: контур, проверен тогда-то» и гнала бы
 * человека чинить сеть вместо прав ключа.
 */
export function emptyKey(catalog: ModelCatalogResponse): string {
  return catalog.source === 'platform' ? 'models.emptyPlatform' : 'models.empty';
}

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

/**
 * Можно ли назначить модель дефолтом.
 *
 * Пропавшую у контура — нельзя: она осталась на экране как объяснение («была,
 * больше нет»), а не как рабочий выбор, и контур такой запрос уже не примет.
 * Дефолт чата — настройка Claude, поэтому чужой вендор туда тоже не годится:
 * чат просто не запустится с такой моделью.
 */
export function canPinModel(catalog: ModelCatalogResponse, model: ModelInfo): boolean {
  if (model.retired) return false;
  return catalog.source === 'platform' ? true : catalog.provider === 'claude';
}

/** Объявленные контуром флаги модели — только те, что он назвал. */
export function declaredFlags(model: ModelInfo): Array<{ key: string; on: boolean }> {
  const flags: Array<{ key: string; on: boolean }> = [];
  if (model.vision !== undefined) flags.push({ key: 'vision', on: model.vision });
  if (model.functionCalling !== undefined)
    flags.push({ key: 'functionCalling', on: model.functionCalling });
  if (model.jsonMode !== undefined) flags.push({ key: 'jsonMode', on: model.jsonMode });
  return flags;
}

/** Значение поля выбора источника, приведённое к допустимому. */
export function sourceValue(raw: string): ModelSource {
  return raw === 'platform' ? 'platform' : 'models.dev';
}
