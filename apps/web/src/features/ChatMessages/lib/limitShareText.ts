import type { LimitShare } from '@agentdeck/contracts';

/**
 * Доля окна процентом. Меньше 10 % — с десятой: группа на пятичасовом окне
 * часто тратит 2–4 %, и округление до целых сливало бы «0,4» и «1,4» в одно.
 */
export function formatSharePercent(share: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: share < 0.1 ? 1 : 0,
  }).format(share);
}

/**
 * Строка карточки группы: «5 ч: N %, неделя: M %». Окно без замеров не
 * пишется вовсе (а не «0 %»): «не мерили» и «не тратили» — разные вещи. Нет
 * ни одного окна — `undefined`, и колонки на карточке нет.
 */
export function limitShareText(
  share: LimitShare | undefined,
  t: (key: string, options: { value: string }) => string,
  locale: string,
): string | undefined {
  if (!share) return undefined;
  const parts: string[] = [];
  if (share.fiveHour !== undefined) {
    parts.push(
      t('chat.cascade.hub.meta.limitFiveHour', {
        value: formatSharePercent(share.fiveHour, locale),
      }),
    );
  }
  if (share.sevenDay !== undefined) {
    parts.push(
      t('chat.cascade.hub.meta.limitSevenDay', {
        value: formatSharePercent(share.sevenDay, locale),
      }),
    );
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}
