import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import {
  configDirOf,
  personalMemoryExcludes,
  type UserMemoryPlace,
} from '../../platform/layers/layers.ts';

/**
 * Карточка правил группы в каталоге личной конфигурации: её кладёт хук начала
 * сессии (`hooks/session-brief.mjs`) звену группы вместо личного `CLAUDE.md`.
 */
export const GROUP_RULES_CARD = ['hooks', 'cards', 'group-rules.md'] as const;

export interface GroupRulesCardSwap {
  /** Шаблоны `claudeMdExcludes`, снимающие личный `CLAUDE.md` из запроса. */
  excludes: string[];
  /** Ставить ли звену метку `USER_MEMORY_OFF_ENV`: личный файл в запрос не идёт. */
  marker: boolean;
}

/**
 * Звену группы (ребёнку разделения) личный `CLAUDE.md` не грузится целиком:
 * его инварианты для стадии несёт карточка ~1,7 тыс. знаков, а сам файл —
 * ~17 тыс. знаков на первом запросе каждой стадии (замер Фазы G 22.10.2026:
 * −14,5 тыс. знаков на запрос с карточкой). Снимаем файл ТОЛЬКО когда карточка
 * есть: без неё звено осталось бы без правил человека вовсе.
 *
 * `alreadyExcluded` — личный файл уже снят слоем запуска («Наши», песочница):
 * исключать нечего, но метку ставим — по ней карточку кладёт хук набора панели.
 */
export function groupRulesCardSwap(
  place: UserMemoryPlace,
  options: { child: boolean; alreadyExcluded: boolean; exists?: (path: string) => boolean },
): GroupRulesCardSwap {
  if (!options.child) return { excludes: [], marker: false };
  if (options.alreadyExcluded) return { excludes: [], marker: true };
  const p = place.platform === 'win32' ? win32 : posix;
  const card = p.join(configDirOf(place), ...GROUP_RULES_CARD);
  if (!(options.exists ?? existsSync)(card)) return { excludes: [], marker: false };
  return { excludes: personalMemoryExcludes(place), marker: true };
}
