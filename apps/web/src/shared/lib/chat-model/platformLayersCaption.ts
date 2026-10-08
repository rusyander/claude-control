import type { OurLayerId, PlatformRunLayers } from '@agentdeck/contracts';
import { ourLayerIds } from '@agentdeck/contracts';

/** Что сказать о наших слоях, снятых с прогона через контур (Т8). */
export interface PlatformLayersCaption {
  /** Ключ словаря: «снято вот это» или «не едет ничего нашего». */
  key: 'chat.platformLayers' | 'chat.platformLayersAll';
  /**
   * Снятые слои. Названия подставляет экран: они лежат в словаре рядом с
   * карточкой контура, и вторая их копия здесь разошлась бы с первой.
   */
  dropped: OurLayerId[];
}

/**
 * Подпись «что из нашего не поедет» — считает СЕРВЕР, здесь только выбор слов.
 *
 * Пусто, когда снимать нечего или прогон ведёт не Claude: у чужого CLI этих
 * флагов нет, сервер поля не присылает, и шапка про наши слои молчит. Молчит она
 * и на полном наборе — строка «ничего не снято» в каждом разговоре была бы шумом
 * ровно там, куда человек смотрит перед отправкой сообщения.
 */
export function platformLayersCaption(
  layers: PlatformRunLayers | undefined,
): PlatformLayersCaption | undefined {
  if (!layers || layers.dropped.length === 0) return undefined;
  const all = layers.dropped.length === ourLayerIds.length;
  return { key: all ? 'chat.platformLayersAll' : 'chat.platformLayers', dropped: layers.dropped };
}
