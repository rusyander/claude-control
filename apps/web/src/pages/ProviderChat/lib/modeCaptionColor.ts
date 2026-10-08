import type { ProviderChatComposerProps } from '../ProviderChatComposer/ProviderChatComposer.types';

export function modeCaptionColor(
  modes: NonNullable<ProviderChatComposerProps['modes']>,
): 'danger' | 'subtle' {
  const available = modes.mode === 'image' ? modes.imageAvailable : modes.deckAvailable;
  return available ? 'subtle' : 'danger';
}
