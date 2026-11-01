/**
 * Страницы списков заглушки — как у обоих форжей: `page` с 1, `per_page` со своим умолчанием и
 * потолком 100. Ленты событий отдают новые первыми, и читающий, который не листает дальше первой
 * страницы, теряет старые события окна — ровно то, что заглушка обязана показать.
 */

/** Потолок ленты событий GitHub: дальше 300 событий страницы не отдаются. */
export const GITHUB_EVENTS_MAX = 300;

export function pageSize(query, fallback) {
  const asked = Number(query.get('per_page') ?? fallback) || fallback;
  return Math.min(100, Math.max(1, asked));
}

export function pageOf(list, query, fallback) {
  const size = pageSize(query, fallback);
  const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
  return list.slice((page - 1) * size, page * size);
}
