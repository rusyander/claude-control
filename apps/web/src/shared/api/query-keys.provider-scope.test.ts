import { describe, it, expect } from 'vitest';
import { isProviderScopedKey } from './query-keys';

/**
 * Что сбрасывается при смене активного CLI. Отчёт аналитики идёт за активным
 * CLI (сессии Codex / Qwen), но его ключ id провайдера не несёт: без сброса
 * минуту после переключения на экране висел бы расход прошлого CLI под именем
 * нового. Прайс и живые процессы `claude` от провайдера не зависят — их сброс
 * лишь гасил бы карточки зря.
 */
describe('isProviderScopedKey — аналитика', () => {
  it('отчёт за любой период сбрасывается', () => {
    expect(isProviderScopedKey(['analytics', '30'])).toBe(true);
    expect(isProviderScopedKey(['analytics', 'today'])).toBe(true);
  });

  it('прайс и живые процессы — нет', () => {
    expect(isProviderScopedKey(['analytics', 'pricing'])).toBe(false);
    expect(isProviderScopedKey(['analytics', 'live'])).toBe(false);
  });
});
