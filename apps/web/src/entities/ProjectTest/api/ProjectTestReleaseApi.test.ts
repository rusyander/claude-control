import { describe, expect, it, vi } from 'vitest';

// React не поднимается (окружение node): хук просто возвращает опции запроса.
let language = 'ru';
vi.mock('@tanstack/react-query', () => ({
  useQuery: <T>(options: T): T => options,
}));
vi.mock('@shared/api/client', () => ({ apiClient: { get: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language } }),
}));

const { useTestRelease } = await import('./ProjectTestReleaseApi');

const useKeyOf = (): unknown =>
  (useTestRelease('C:/p', 'v1') as unknown as { queryKey: unknown }).queryKey;

/**
 * Вердикт вехи сервер пишет на языке панели. Ключ без языка отдавал после
 * переключения прежний документ из кэша — карточка оставалась на старом языке
 * до перезагрузки.
 */
describe('готовность вехи кэшируется отдельно на каждом языке', () => {
  it('смена языка панели — другой ключ запроса', () => {
    language = 'ru';
    const ru = useKeyOf();
    language = 'en';
    const en = useKeyOf();
    expect(en).not.toEqual(ru);
  });

  it('тот же язык — тот же ключ', () => {
    language = 'en';
    expect(useKeyOf()).toEqual(useKeyOf());
  });
});
