import { LOCAL_PLATFORM_ID } from '@agentdeck/contracts/platform-layers';

/**
 * Контур локальной модели человеку называется «Локальная модель · llama.cpp», а не
 * контуром (L6, слово владельца 15.10: «через контур» над ответом своей видеокарты
 * читалось как уход наружу). Те же подписи, другие слова: ключ контура меняется на
 * ключ локального прогона, логика выбора подписи остаётся одной.
 */
export function isLocalRoute(plan: { platformId?: string } | undefined): boolean {
  return plan?.platformId === LOCAL_PLATFORM_ID;
}

const LOCAL_KEYS = {
  'chat.platformModel': 'chat.localRoute.model',
  'chat.platformModelUnset': 'chat.localRoute.modelUnset',
  'chat.platformNoEffort': 'chat.localRoute.noEffort',
  'chat.platformLocked': 'chat.localRoute.locked',
  'chat.platformLayers': 'chat.localRoute.layers',
  'chat.platformLayersAll': 'chat.localRoute.layersAll',
} as const;

export type RouteKey = keyof typeof LOCAL_KEYS;
export type RouteWordsKey = RouteKey | (typeof LOCAL_KEYS)[RouteKey];

/** Ключ подписи прогона: у локального контура — его слова, у остальных — слова контура. */
export function routeKey<K extends RouteKey>(key: K, local: boolean): K | (typeof LOCAL_KEYS)[K] {
  return local ? LOCAL_KEYS[key] : key;
}

/** Название контура для человека: у локального — «Локальная модель · llama.cpp» на его языке. */
export function platformTitleOf(
  platform: { id: string; title: string },
  t: (key: 'chat.localRoute.label') => string,
): string {
  return platform.id === LOCAL_PLATFORM_ID ? t('chat.localRoute.label') : platform.title;
}
