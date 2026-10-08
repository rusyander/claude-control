/** Пустой набор переключённых — один на все отрисовки, чтобы useMemo не пересчитывал зря. */
export const EMPTY_IDS: ReadonlySet<string> = new Set();

/** Адрес страницы файла целиком — на неё ведёт объясняющая заглушка. */
export const CLAUDE_MD_ROUTE: string = '/claude-md';
