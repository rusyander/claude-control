/**
 * Лимиты подписки — полоса на главной и в шапке чата. Отдельным модулем, как
 * главная: словарь общий, а правят его одновременно несколько разделов.
 */
export const usageLimitsRu = {
  session: 'Сессия',
  weekly: 'Неделя',
  weeklyModel: (model: string) => `Неделя · ${model}`,
  // Сколько до сброса окна: «1 ч 35 м», «4 д 3 ч», «12 м».
  untilDays: (d: number, h: number) => `${d} д ${h} ч`,
  untilHours: (h: number, m: number) => `${h} ч ${m} м`,
  untilMinutes: (m: number) => `${m} м`,
  untilSoon: 'сейчас',
  resetIn: (until: string) => `сброс через ${until}`,
  // Прочитанное вслух целиком: глазами процент и время читают по цвету и месту.
  a11y: (label: string, percent: string, until: string | null) =>
    until ? `${label}: использовано ${percent}, ${until}` : `${label}: использовано ${percent}`,
  // Окна последнего ответа, а свежий получить не удалось.
  stale: 'не обновилось',
};

export type UsageLimitsTexts = typeof usageLimitsRu;
