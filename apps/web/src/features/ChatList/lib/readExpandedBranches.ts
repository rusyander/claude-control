import { EXPANDED_BRANCHES_KEY } from '../model/expandedBranches.constants';

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
