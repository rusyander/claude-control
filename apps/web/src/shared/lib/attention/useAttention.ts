import { useEffect, useSyncExternalStore } from 'react';
import { useActiveRuns } from '@shared/lib/agent-runs';
import { getDismissed, subscribeDismissed } from './attentionStore';
import { selectAttention, attentionTitle, type AttentionView } from './attention';
import { applyFaviconBadge } from './favicon';

/** Кто сейчас зовёт человека — для точек в интерфейсе. */
export function useAttention(): AttentionView {
  const runs = useActiveRuns();
  const dismissed = useSyncExternalStore(subscribeDismissed, getDismissed, getDismissed);
  return selectAttention(runs, dismissed);
}

/**
 * Метка в самом браузере: точка на значке вкладки и в её заголовке. Ставится на
 * уровне приложения, а не страницы чата, — уйти в «Настройки» и не узнать, что
 * агент спросил, было бы худшим из исходов.
 */
export function useAttentionBadge(): void {
  const { count, tone } = useAttention();

  useEffect(() => {
    // Исходный заголовок запоминаем один раз: иначе после первой же метки
    // «базой» станет уже помеченный текст и точки начнут копиться.
    const base = baseTitle();
    document.title = attentionTitle(base, count);
    applyFaviconBadge(tone);
  }, [count, tone]);
}

let remembered: string | undefined;

function baseTitle(): string {
  remembered ??= document.title;
  return remembered;
}
