import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { i18n } from '@shared/config/i18n';
import type { ChildStageGroup } from '../ChildStages.types';
import { ChildStages } from './ChildStages';

/**
 * Время приёмки и обрыва группы в хабе — языком интерфейса, а не браузера:
 * английская панель в русском браузере показывала «01.09.2026, 15:24» (F-323,
 * родственник в хабе). Язык интерфейса берётся противоположным языку среды —
 * иначе проверка зеленела бы и на старом коде.
 */
const AT = '2026-09-01T12:24:00.000Z';
const envIsRu = new Intl.DateTimeFormat().resolvedOptions().locale.startsWith('ru');
const LANG = envIsRu ? 'en' : 'ru';

const group: ChildStageGroup = {
  chatId: 'child-1',
  title: 'G1',
  stages: [],
  isRunning: false,
  interrupted: { index: 0, at: AT },
  acceptance: { parentChatId: 'parent', index: 0, acceptedAt: AT },
};

const render = (): string =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChildStages groups={[group]} onOpen={() => {}} />
    </QueryClientProvider>,
  );

beforeAll(async () => {
  await i18n.changeLanguage(LANG);
});

afterAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('хаб разделения — даты языком интерфейса', () => {
  it('отметка приёмки: подсказка с датой в формате языка интерфейса', () => {
    const html = render();
    const expected = new Date(AT).toLocaleString(LANG);
    expect(expected).not.toBe(new Date(AT).toLocaleString());
    expect(html).toContain(`title="${expected}"`);
  });

  it('время обрыва — в формате языка интерфейса', () => {
    const html = render();
    const time = new Date(AT).toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' });
    expect(html).toContain(time);
  });
});
