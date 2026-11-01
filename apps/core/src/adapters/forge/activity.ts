import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ForgeActivity, ForgeKind } from '@agentdeck/contracts/core/forge';

/**
 * Окно ленты событий (05:77): обе ленты отдают НОВЫЕ первыми, страницами. Чтение листает назад,
 * пока не дойдёт до `since` (самая старая строка страницы раньше `since`) или до конца ленты
 * (страница короче полной). Потолок страниц не дошёл до `since` — `unknown`: молча срезанное
 * окно потеряло бы заметки ревьюера, а отметка опроса уехала бы за них.
 */

export const ACTIVITY_PAGE = 100;
/** GitHub отдаёт не больше 300 событий ленты; GitLab — сколько есть, предел наш. */
export const ACTIVITY_MAX_PAGES: Record<Exclude<ForgeKind, 'generic'>, number> = {
  gitlab: 20,
  github: 3,
};

/** Одна страница ленты: сколько строк пришло (полная ли) и что из них разобрано. */
export interface ActivityPage {
  rows: number;
  acts: ForgeActivity[];
}

export async function activityWindow(
  kind: Exclude<ForgeKind, 'generic'>,
  since: number,
  page: (n: number) => Promise<Fact<ActivityPage>>,
): Promise<Fact<ForgeActivity[]>> {
  const max = ACTIVITY_MAX_PAGES[kind];
  // Новое событие между страницами сдвигает ленту: строка приходит дважды, не пропадает — id снимает повтор.
  const byId = new Map<string, ForgeActivity>();
  for (let n = 1; n <= max; n += 1) {
    const got = await page(n);
    if (!('value' in got)) return got;
    for (const a of got.value.acts) byId.set(a.id, a);
    const oldest = Math.min(...got.value.acts.map((a) => a.at));
    if (got.value.rows < ACTIVITY_PAGE || oldest < since) return { value: [...byId.values()] };
  }
  return {
    unknown: `events: the window since ${new Date(since).toISOString()} is older than ${max} pages of ${ACTIVITY_PAGE} (page cap)`,
  };
}
