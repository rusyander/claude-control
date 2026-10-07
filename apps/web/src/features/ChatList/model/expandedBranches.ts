import { useCallback, useState } from 'react';

/** Ключ памяти раскрытых ветвей списка чатов — в браузере зрителя. */
export const EXPANDED_BRANCHES_KEY = 'agentdeck.chatList.expanded';

/**
 * Раскрытые гармошки ветвей (G1): id родителей, чьи свёрнутые дети показаны.
 *
 * Память — удобство, а не данные: хранилище бывает недоступно (приватное окно,
 * запрет сайта) или испорчено руками — тогда все ветви свёрнуты, как в первый
 * раз, и список работает. Чужие значения (не строки) отбрасываются молча.
 */
export function readExpandedBranches(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(EXPANDED_BRANCHES_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : [],
    );
  } catch {
    return new Set();
  }
}

export function writeExpandedBranches(expanded: ReadonlySet<string>): void {
  try {
    globalThis.localStorage?.setItem(EXPANDED_BRANCHES_KEY, JSON.stringify([...expanded]));
  } catch {
    // Не запомнилось — при следующем открытии ветвь просто свёрнута.
  }
}

/** Раскрыта ли ветвь — и переключатель, который сразу пишет память. */
export function useExpandedBranches(): {
  expanded: ReadonlySet<string>;
  toggle: (parentId: string) => void;
} {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(readExpandedBranches);
  const toggle = useCallback((parentId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      writeExpandedBranches(next);
      return next;
    });
  }, []);
  return { expanded, toggle };
}
