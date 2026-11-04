import { afterEach, describe, expect, it } from 'vitest';
import type { EnvNeeds } from '@agentdeck/contracts/portable-env';
import { serverFieldText } from '@shared/config/i18n';
import { i18n } from '@shared/config/i18n/instance';
import { needsSummary } from './needsSummary';

const CYRILLIC = /[А-Яа-яЁё]/;

/**
 * Паспорт среды под английским интерфейсом. Причину «рантайм не нужен» и фразу
 * записи сервер пишет по-русски и кладёт рядом код; без перевода по коду кадр
 * справки «Every entry of this kind needs the same:» продолжался русской фразой.
 */
describe('паспорт: причина требований и фраза записи на языке интерфейса', () => {
  afterEach(async () => {
    await i18n.changeLanguage('ru');
  });

  const instructions: EnvNeeds = {
    resolution: 'none',
    why: 'текст инструкций читает модель; фактов рантайма ему не нужно',
    whyCode: 'portability-needs-instructions',
  };

  it('под en причина с кодом — английская, без кириллицы', async () => {
    await i18n.changeLanguage('en');
    const { why } = needsSummary(instructions, i18n.t.bind(i18n));
    expect(why).toBe('the model reads the instructions text; it needs no runtime facts');
    expect(why).not.toMatch(CYRILLIC);
  });

  it('параметры причины подставляются в перевод', async () => {
    await i18n.changeLanguage('en');
    const unread: EnvNeeds = {
      resolution: 'undetermined',
      why: 'скрипт /h/x.sh не прочитан: нет доступа',
      whyCode: 'portability-needs-script-unread',
      whyParams: { path: '/h/x.sh', detail: 'EACCES' },
    };
    expect(needsSummary(unread, i18n.t.bind(i18n)).why).toBe('script /h/x.sh was not read: EACCES');
  });

  it('под ru — тот же русский текст; без кода — текст сервера как есть', async () => {
    await i18n.changeLanguage('ru');
    expect(needsSummary(instructions, i18n.t.bind(i18n)).why).toBe(instructions.why);
    await i18n.changeLanguage('en');
    const legacy: EnvNeeds = { resolution: 'none', why: 'старый паспорт без кода' };
    expect(needsSummary(legacy, i18n.t.bind(i18n)).why).toBe('старый паспорт без кода');
  });

  it('фраза записи инструкций под en — английская, имя файла на месте', async () => {
    await i18n.changeLanguage('en');
    const item = {
      intent: 'файл инструкций CLAUDE.md: его текст читает модель в каждом разговоре',
      intentCode: 'portability-intent-instructions',
      intentParams: { name: 'CLAUDE.md' },
    };
    expect(serverFieldText(item, 'intent', i18n.t.bind(i18n))).toBe(
      'instructions file CLAUDE.md: the model reads its text in every conversation',
    );
  });
});
