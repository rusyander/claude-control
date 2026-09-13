import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  MediaDeck,
  MediaDeckFormat,
  MediaDeckPlan,
  MediaImage,
  MediaImagePlan,
} from '@agentdeck/contracts';
import { apiClient, LONG_TIMEOUTS } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Транспорт: чистые функции, ничего не знающие про React.

/**
 * Признак «здесь есть агент» уезжает ЗАПРОСОМ, а решение остаётся за сервером:
 * страница знает про свой разговор, но не знает ни драйвера контура, ни каталога
 * ключа, ни того, какая дорога дешевле.
 */
function agentQuery(agent: boolean): string {
  return agent ? '?agent=1' : '';
}

async function getImagePlan(agent: boolean): Promise<MediaImagePlan> {
  const { data } = await apiClient.get<MediaImagePlan>(`/media/images/plan${agentQuery(agent)}`);
  return data;
}

async function getDeckPlan(agent: boolean): Promise<MediaDeckPlan> {
  const { data } = await apiClient.get<MediaDeckPlan>(`/media/decks/plan${agentQuery(agent)}`);
  return data;
}

async function createImage(request: { chatId: string; prompt: string }): Promise<MediaImage> {
  const { data } = await apiClient.post<MediaImage>('/media/images', request, {
    // Рисование — минуты: обычный потолок ответа здесь оборвал бы удачный запрос
    // и списал бы деньги ключа впустую.
    timeout: LONG_TIMEOUTS.mediaImage,
  });
  return data;
}

async function createDeck(request: {
  chatId: string;
  prompt: string;
  /** Правка готовой колоды: её структура уедет модели вместе с просьбой. */
  reviseOf?: string;
}): Promise<MediaDeck> {
  const { data } = await apiClient.post<MediaDeck>('/media/decks', request, {
    timeout: LONG_TIMEOUTS.mediaDeck,
  });
  return data;
}

/** Рисунок, который агент отдал блоком: панель его проверит и положит файлом. */
async function savePicture(request: {
  chatId: string;
  prompt: string;
  block: string;
  model: string;
}): Promise<MediaImage> {
  const { data } = await apiClient.post<MediaImage>('/media/images/block', request);
  return data;
}

/** Колода из блока агента: сборка файлов идёт на сервере, поэтому свой потолок. */
async function saveDeck(request: {
  chatId: string;
  prompt: string;
  block: string;
  model: string;
  /**
   * Колода, которую этот блок заменяет. Без неё правка потеряла бы картинки
   * прежней колоды: панель принимает их имена только из ЕЁ набора.
   */
  reviseOf?: string;
}): Promise<MediaDeck> {
  const { data } = await apiClient.post<MediaDeck>('/media/decks/block', request, {
    timeout: LONG_TIMEOUTS.mediaDeck,
  });
  return data;
}

/**
 * Готовая просьба к агенту. Собирает её СЕРВЕР: правила лежат в каталоге промптов
 * (единственное место, где человек их правит), и вторая сборка здесь разошлась бы
 * с ними после первой же правки.
 */
async function mediaPrompt(
  kind: MediaPromptKind,
  topic: string,
  reviseOf?: string,
): Promise<string> {
  const { data } = await apiClient.post<{ prompt: string }>('/media/prompt', {
    kind,
    topic,
    ...(reviseOf ? { reviseOf } : {}),
  });
  return data.prompt;
}

/**
 * Виды просьбы. Правка — отдельный вид, а не поле: в её текст уезжает структура
 * прежней колоды, и собрать такую просьбу может только сервер (у страницы этой
 * структуры нет).
 */
export type MediaPromptKind = 'deck' | 'deck-revise' | 'picture';

/**
 * Адрес байтов картинки. Тот же и для показа, и для скачивания, и для телефона:
 * второй адрес означал бы второй маршрут и второе место, где он может разойтись
 * с первым.
 */
export function mediaImageUrl(id: string): string {
  return `/api/media/images/${encodeURIComponent(id)}`;
}

/**
 * Адрес файла презентации. Ссылкой, а не запросом: HTML открывается в своей
 * вкладке целым экраном (колоду так и смотрят), PPTX сохраняется средствами
 * системы, а PDF печатается сервером при первом спросе — браузер покажет
 * ожидание сам, и нести это через наш слой данных незачем.
 */
export function mediaDeckUrl(id: string, format: MediaDeckFormat): string {
  return `/api/media/decks/${encodeURIComponent(id)}/${format}`;
}

/**
 * Чем нарисуем. Спрашивается ДО нажатия: пункт «Картинка» обязан быть либо
 * рабочим, либо запертым с причиной, а не отвечать отказом после того, как
 * человек уже описал картинку.
 */
export function useImagePlan(agent: boolean) {
  return useQuery({
    queryKey: queryKeys.mediaImagePlan(agent),
    queryFn: () => getImagePlan(agent),
  });
}

/** То же для презентации: кто соберёт колоду и получится ли PDF. */
export function useDeckPlan(agent: boolean) {
  return useQuery({
    queryKey: queryKeys.mediaDeckPlan(agent),
    queryFn: () => getDeckPlan(agent),
  });
}

export function useCreateImage() {
  return useMutation({ mutationFn: createImage });
}

export function useCreateDeck() {
  return useMutation({ mutationFn: createDeck });
}

export function useSavePicture() {
  return useMutation({ mutationFn: savePicture });
}

export function useSaveDeck() {
  return useMutation({ mutationFn: saveDeck });
}

export function useMediaPrompt() {
  return useMutation({
    mutationFn: ({
      kind,
      topic,
      reviseOf,
    }: {
      kind: MediaPromptKind;
      topic: string;
      reviseOf?: string;
    }) => mediaPrompt(kind, topic, reviseOf),
  });
}
