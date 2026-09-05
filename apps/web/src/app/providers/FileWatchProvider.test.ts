import { describe, it, expect } from 'vitest';
import { shouldReconnectOnWake } from './FileWatchProvider';

/**
 * Возвращение к вкладке.
 *
 * Регрессия, ради которой написано: поток изменений пересоздавался на КАЖДЫЙ
 * `visibilitychange`, а его `onopen` считал это переподключением и перечитывал
 * все разделы разом — Alt-Tab туда-обратно стоил панели полной перезагрузки
 * данных, да ещё и лишнего соединения из шести, что браузер даёт на источник.
 */
describe('shouldReconnectOnWake — пересоздавать ли поток изменений', () => {
  it('короткое переключение окна — поток живой, не трогаем', () => {
    expect(shouldReconnectOnWake({ awayMs: 1200, closed: false })).toBe(false);
  });

  it('долгое отсутствие (сон машины, спящая вкладка) — переподключаемся', () => {
    expect(shouldReconnectOnWake({ awayMs: 5 * 60_000, closed: false })).toBe(true);
  });

  it('поток закрыт — переподключаемся, сколько бы нас ни не было', () => {
    expect(shouldReconnectOnWake({ awayMs: 0, closed: true })).toBe(true);
  });
});
