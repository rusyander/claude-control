import type { ModelInfo } from '@claude-control/contracts';

/**
 * Источник каталога моделей — открытый JSON models.dev.
 *
 * Своего публичного «списка моделей» без ключа нет ни у Anthropic, ни у OpenAI,
 * ни у Google: их API моделей требуют авторизации, а панель по построению
 * работает и без единого ключа (подписка живёт внутри CLI). models.dev отдаёт
 * один документ со всеми вендорами — идентификаторы, семейства, даты выхода,
 * лимиты, — и им же пользуется OpenCode, то есть источник не самодельный.
 *
 * Разбор осторожный: пропускаем всё, что не похоже на модель, и никогда не
 * додумываем поля. Не разобрали — вызывающий остаётся на прошлом кэше: показать
 * вчерашний список не страшно, показать выдуманную модель — страшно.
 */
export const MODELS_URL = 'https://models.dev/api.json';

/** Сеть не должна подвешивать открытие настроек. */
const FETCH_TIMEOUT_MS = 15_000;

/** Документ большой (~3 МБ) — защита от подсунутого гигантского ответа. */
const MAX_BYTES = 32 * 1024 * 1024;

/**
 * Разбор документа каталога. `vendors` — какие вендоры интересны; остальные
 * отбрасываются сразу, чтобы в кэш не уезжали 170 чужих провайдеров.
 */
export function parseModelCatalog(raw: unknown, vendors: string[]): ModelInfo[] {
  if (!raw || typeof raw !== 'object') return [];

  const document = raw as Record<string, unknown>;
  const models: ModelInfo[] = [];

  for (const vendor of vendors) {
    const entry = document[vendor];
    if (!entry || typeof entry !== 'object') continue;

    const list = (entry as Record<string, unknown>).models;
    if (!list || typeof list !== 'object') continue;

    for (const value of Object.values(list as Record<string, unknown>)) {
      const model = parseModel(value, vendor);
      if (model) models.push(model);
    }
  }

  return sortModels(models);
}

/** Свежие сверху; без даты — в конец, там же по имени. */
export function sortModels(models: ModelInfo[]): ModelInfo[] {
  return [...models].sort((left, right) => {
    const byDate = releaseKey(right.releaseDate).localeCompare(releaseKey(left.releaseDate));
    return byDate !== 0 ? byDate : left.id.localeCompare(right.id);
  });
}

/**
 * Дата к сравнимому виду. В каталоге встречается и `2026-07-24`, и `2025-04`
 * (у части моделей Alibaba указан только месяц) — неполную достраиваем первым
 * числом, отсутствующую отправляем в конец списка.
 */
export function releaseKey(date: string | undefined): string {
  if (!date) return '0000-00-00';
  const parts = date.split('-');
  const year = parts[0] ?? '0000';
  const month = (parts[1] ?? '01').padStart(2, '0');
  const day = (parts[2] ?? '01').padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseModel(value: unknown, vendor: string): ModelInfo | undefined {
  if (!value || typeof value !== 'object') return undefined;

  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return undefined;

  // Семейство — опора автозамены дефолта. Нет его — модель в списке покажем,
  // но участвовать в «вышла новее» она не будет: сравнивать не с чем.
  const family = typeof raw.family === 'string' ? raw.family : '';
  const limit =
    raw.limit && typeof raw.limit === 'object' ? (raw.limit as Record<string, unknown>) : {};

  const model: ModelInfo = {
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : id,
    family,
    vendor,
  };

  if (typeof raw.release_date === 'string' && raw.release_date)
    model.releaseDate = raw.release_date;
  if (raw.reasoning === true) model.reasoning = true;
  if (typeof limit.context === 'number') model.contextLimit = limit.context;
  if (typeof limit.output === 'number') model.outputLimit = limit.output;

  return model;
}

/** Скачать и разобрать каталог. Бросает, если не вышло, — решает вызывающий. */
export async function fetchModels(vendors: string[], url = MODELS_URL): Promise<ModelInfo[]> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Каталог моделей недоступен: HTTP ${response.status}`);

  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error('Каталог моделей неправдоподобно велик');

  const models = parseModelCatalog(JSON.parse(text) as unknown, vendors);
  if (models.length === 0) throw new Error('В каталоге нет ни одной модели нужных вендоров');

  return models;
}
