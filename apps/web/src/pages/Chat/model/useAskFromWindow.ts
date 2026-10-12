import { useRef } from 'react';
import type { DraftBox } from '@shared/lib/draft';

/**
 * Просьба агенту из окна проекта: дописывается к начатому, окно закрывается,
 * а фокус окно отдаёт полю чата вместо кнопки «Окружение» — человеку остаётся
 * дописать и отправить.
 */
export function useAskFromWindow(draft: DraftBox, closeWindow: () => void) {
  const focusComposerOnClose = useRef(false);
  const askAgent = (text: string): void => {
    const current = draft.get().trim();
    draft.set(current ? `${current}\n\n${text}` : text);
    focusComposerOnClose.current = true;
    closeWindow();
  };
  const focusOnClose = (): HTMLElement | null | undefined => {
    if (!focusComposerOnClose.current) return undefined;
    focusComposerOnClose.current = false;
    return document.querySelector<HTMLElement>('[data-chat-input]');
  };
  return { askAgent, focusOnClose };
}
