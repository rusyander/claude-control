import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@shared/config/i18n';

/** Пороги сторожа в настройках: «5 раза» читалось бы как опечатка. */
describe('сторож групп: форма «раз» по числу', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ru');
  });

  it('2–4 — «раза», 5 и 21 — «раз»', () => {
    const times = (count: number): string =>
      i18n.t('groupWatch.settings.unit.times', { value: String(count), count });
    expect([2, 3, 5, 21].map(times)).toEqual(['2 раза', '3 раза', '5 раз', '21 раз']);
  });
});
