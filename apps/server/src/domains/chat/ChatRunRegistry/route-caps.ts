import type { GroupRunProfile } from '../group-profile/group-profile.ts';
import type { PlatformRunRoute } from '../../platform/routing/routing.ts';

/**
 * Пределы маршрута сильнее пределов группы (n2, n1).
 *
 * Профиль группы кладётся ПОСЛЕ окружения маршрута (`platformEnv`), а потолок
 * чтения — в `--settings`, который перебивает окружение процесса. На локальной
 * модели с окном 32 тыс. группа поэтому получала окно 200 тыс. и потолок чтения
 * 10 тыс. вместо 4 тыс.: сжатие истории не наступало никогда, а чтение файла
 * переполняло окно. Рычаг экономии там, где окно маршрута меньше, обязан
 * уступать: берётся меньшее из двух по каждому ключу.
 *
 * Окно модели по каталогу контура (`modelContext`) — тот же предел: окно группы
 * выше него означает отказ контура раньше, чем CLI сожмёт историю.
 *
 * Набор панели (В2, режим «Наши») кладёт свои потолки окружением ПОСЛЕ маршрута
 * (`OURS_CLAUDE_CAPS`: чтение 10 тыс.) и затирал ими 4 тыс. локальной модели тем же
 * путём, что и профиль (ревью K, 🟡1). Поэтому меньшее берётся из всех трёх
 * источников: маршрут, набор, группа — каждый прижат здесь один раз.
 *
 * Мимо контура окружение маршрута пусто, и ни профиль, ни набор не меняются ни в
 * одном байте: потолок набора против потолка группы там решает сам CLI
 * (`--settings` сильнее окружения), как и прежде.
 */

/** Окно автосжатия CLI (2.1.286) — тот же ключ, что ставят профиль группы и локальная модель. */
const COMPACT_WINDOW_ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
/** Потолок ответа чтения файла: у профиля — в `--settings`, у локальной модели — окружением. */
const READ_MAX_TOKENS_ENV = 'CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS';

function positive(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function minOf(...values: (number | undefined)[]): number | undefined {
  const known = values.filter((value): value is number => value !== undefined);
  return known.length > 0 ? Math.min(...known) : undefined;
}

/** Значение под потолком; потолка или значения нет — как было. */
function capped(value: string | undefined, cap: number | undefined): string | undefined {
  const own = positive(value);
  return own !== undefined && cap !== undefined && own > cap ? String(cap) : undefined;
}

type CapRoute = Pick<PlatformRunRoute, 'env' | 'modelContext' | 'kit'>;

/**
 * Пределы прогона по ключу: свой предел маршрута, прижатый пределом набора. Своего
 * у маршрута нет — нет и предела: набор и группа мимо контура остаются как были.
 */
function routeCaps(route: CapRoute): { window?: number; read?: number } {
  const kit = route.kit?.env ?? {};
  const window = minOf(positive(route.env[COMPACT_WINDOW_ENV]), positive(route.modelContext));
  const read = positive(route.env[READ_MAX_TOKENS_ENV]);
  return {
    ...(window === undefined ? {} : { window: minOf(window, positive(kit[COMPACT_WINDOW_ENV])) }),
    ...(read === undefined ? {} : { read: minOf(read, positive(kit[READ_MAX_TOKENS_ENV])) }),
  };
}

/**
 * Значение набора под пределом маршрута. «0» и пустое у набора — «решает CLI», то
 * есть без предела: поверх окружения маршрута оно сняло бы его предел, поэтому под
 * пределом становится им самим.
 */
function kitCapped(value: string | undefined, cap: number | undefined): string | undefined {
  if (value === undefined || cap === undefined) return undefined;
  const own = positive(value);
  return own === undefined || own > cap ? String(cap) : undefined;
}

/**
 * Окружение набора панели под пределами маршрута. Тот же объект, когда прижимать
 * нечего: мимо контура, предел набора ниже маршрута, у набора нет ключа.
 */
export function capKitToRoute(route: CapRoute): Record<string, string> | undefined {
  const env = route.kit?.env;
  if (!env) return env;
  const caps = routeCaps(route);
  const window = kitCapped(env[COMPACT_WINDOW_ENV], caps.window);
  const read = kitCapped(env[READ_MAX_TOKENS_ENV], caps.read);
  if (window === undefined && read === undefined) return env;
  return {
    ...env,
    ...(window === undefined ? {} : { [COMPACT_WINDOW_ENV]: window }),
    ...(read === undefined ? {} : { [READ_MAX_TOKENS_ENV]: read }),
  };
}

export function capProfileToRoute(profile: GroupRunProfile, route: CapRoute): GroupRunProfile {
  const { window: windowCap, read: readCap } = routeCaps(route);
  const window = capped(profile.env[COMPACT_WINDOW_ENV], windowCap);
  const settingsEnv = profile.settings.env;
  const readEnv =
    settingsEnv && typeof settingsEnv === 'object' && !Array.isArray(settingsEnv)
      ? (settingsEnv as Record<string, string>)
      : undefined;
  const read = capped(readEnv?.[READ_MAX_TOKENS_ENV], readCap);
  if (window === undefined && read === undefined) return profile;
  return {
    ...profile,
    env: window === undefined ? profile.env : { ...profile.env, [COMPACT_WINDOW_ENV]: window },
    settings:
      read === undefined
        ? profile.settings
        : { ...profile.settings, env: { ...readEnv, [READ_MAX_TOKENS_ENV]: read } },
  };
}
