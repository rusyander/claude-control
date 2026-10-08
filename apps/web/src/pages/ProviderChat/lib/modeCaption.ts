import type { ProviderChatComposerProps } from '../ProviderChatComposer/ProviderChatComposer.types';

/** Что сказать под меню: причина сильнее подписи маршрута. */
export function modeCaption(
  modes: NonNullable<ProviderChatComposerProps['modes']>,
  t: (key: string) => string,
): string {
  if (modes.mode === 'image') {
    if (!modes.imageAvailable) return modes.imageReason ?? t('chat.mode.imageBlocked');
    return modes.imageSource ?? t('chat.mode.imageHint');
  }
  if (!modes.deckAvailable) return modes.deckReason ?? t('chat.mode.deckBlocked');
  return modes.deckSource ?? t('chat.mode.deckHint');
}
