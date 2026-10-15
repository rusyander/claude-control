import type { OurLayerId, PlatformRunLayers } from '@agentdeck/contracts';
import { ourLayerIds } from '@agentdeck/contracts';
import { routeKey } from './localRoute';

/** Что сказать о наших слоях, снятых с прогона через контур (Т8). */
export interface PlatformLayersCaption {
  /** Ключ словаря: «снято вот это» или «не едет ничего нашего». */
  key:
    | ReturnType<typeof routeKey<'chat.platformLayers'>>
    | ReturnType<typeof routeKey<'chat.platformLayersAll'>>;
  /**
   * Снятые слои. Названия подставляет экран: они лежат в словаре рядом с
   * карточкой контура, и вторая их копия здесь разошлась бы с первой.
   */
  dropped: OurLayerId[];
  /** MCP-серверы, взятые человеком в локальный прогон (L4): они едут, хотя слой снят. */
  picked: string[];
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
  localMcp?: { picked: string[] },
  /** Прогон ведёт контур локальной модели: слова «Локальная модель · llama.cpp» (L6). */
  local = false,
): PlatformLayersCaption | undefined {
  if (!layers || layers.dropped.length === 0) return undefined;
  const all = layers.dropped.length === ourLayerIds.length;
  return {
    key: all ? routeKey('chat.platformLayersAll', local) : routeKey('chat.platformLayers', local),
    dropped: layers.dropped,
    picked: layers.dropped.includes('mcp') ? (localMcp?.picked ?? []) : [],
  };
}
