import type {
  ModelSourceFallback,
  Platform,
  PlatformHealthRecord,
} from '@agentdeck/contracts';

/**
 * Решение: собирать каталог из контура или откатываться на models.dev.
 *
 * Отдельным модулем от маршрута, потому что решений тут пять, а не одно, и
 * каждое из них человек чинит в своём месте: выключенный контур — тумблером,
 * непроверенный — кнопкой «Проверить связь», пропавший — выбором другого.
 * Свернуть их в «источник недоступен» значило бы отправить человека искать
 * поломку наугад.
 *
 * ОТКАТ НИКОГДА НЕ МОЛЧИТ. Каталог — это список того, чем человек собирается
 * пользоваться; подменить его другим списком без объяснения значит соврать о
 * том, что ему доступно.
 */

export interface PlatformSourceInput {
  /** Что выбрано в настройках (`modelSourcePlatform`). */
  platformId: string;
  /** Контур с этим идентификатором, если он ещё есть в настройках. */
  platform: Platform | undefined;
  /** Сохранён ли ключ контура. Значение ключа сюда не попадает никогда. */
  hasToken: boolean;
  /** След последней пробы, если она была. */
  health: PlatformHealthRecord | undefined;
}

export type PlatformSourceDecision =
  | { ok: true; platform: Platform; health: PlatformHealthRecord }
  | { ok: false; fallback: ModelSourceFallback; platform?: Platform };

export function resolvePlatformSource(input: PlatformSourceInput): PlatformSourceDecision {
  const { platformId, platform, hasToken, health } = input;

  if (!platformId) return { ok: false, fallback: 'no-platform' };
  if (!platform) return { ok: false, fallback: 'platform-gone' };

  // Выключенный контур и контур без ключа — одна беда для человека: панель к
  // нему не пойдёт. Разводить их на две строки незачем, обе чинятся в карточке.
  if (!platform.enabled || !hasToken) return { ok: false, fallback: 'platform-off', platform };

  if (!health) return { ok: false, fallback: 'never-checked', platform };

  // Проба неудачна И удачной не было ни одной — показывать нечего: список
  // моделей у панели не появлялся. Если удачная БЫЛА, работаем по её списку:
  // он пережил неудачу вместе с датой `lastOkAt`, и это ровно тот офлайн,
  // ради которого каталог вообще кэшируется.
  if (health.outcome !== 'ok' && !health.lastOkAt) {
    return { ok: false, fallback: 'never-answered', platform };
  }

  // Удачная проба без единой модели — не повод откатываться: «ключу не выдано
  // ни одной модели» это ответ контура, и подменять его чужим списком значило
  // бы скрыть от человека настоящее положение дел с его ключом.
  return { ok: true, platform, health };
}

/**
 * Когда каталог контура считается устаревшим.
 *
 * Порог тот же, что у models.dev (сутки): состав моделей ключа меняется не
 * чаще. Дата берётся от последнего УСПЕХА, а не от последней пробы — иначе
 * неудачная проверка молодила бы список, который она не подтверждала.
 */
export function isPlatformCatalogStale(health: PlatformHealthRecord, maxAgeMs: number): boolean {
  const stamp = health.lastOkAt ?? health.checkedAt;
  const age = Date.now() - Date.parse(stamp);
  // Нечитаемая дата даёт NaN, а сравнение с NaN всегда ложно — каталог
  // считался бы свежим вечно и никогда не попросил бы проверки.
  return !Number.isFinite(age) || age > maxAgeMs;
}
