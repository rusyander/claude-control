import { describe, it, expect } from 'vitest';
import { settingsPatchSchema } from './settings-validation.ts';

/**
 * Серверная схема PATCH — своя копия контрактной, разъезжаться им нельзя.
 * Здесь проверяем именно новые поля MCP: без них в этой схеме сервер молча
 * выбросил бы их из тела PATCH, и настройка не сохранилась бы в state.json.
 */
describe('settingsPatchSchema — поля MCP', () => {
  it('пропускает валидный сетевой таймаут и автопроверку', () => {
    const parsed = settingsPatchSchema.safeParse({
      mcpNetworkTimeoutMs: 15_000,
      mcpAutoCheck: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.mcpNetworkTimeoutMs).toBe(15_000);
      expect(parsed.data.mcpAutoCheck).toBe(true);
    }
  });

  it('отклоняет таймаут ниже нижней границы', () => {
    expect(settingsPatchSchema.safeParse({ mcpNetworkTimeoutMs: 1_000 }).success).toBe(false);
  });

  it('отклоняет таймаут выше верхней границы', () => {
    expect(settingsPatchSchema.safeParse({ mcpNetworkTimeoutMs: 200_000 }).success).toBe(false);
  });

  it('отклоняет нецелый таймаут', () => {
    expect(settingsPatchSchema.safeParse({ mcpNetworkTimeoutMs: 10_000.5 }).success).toBe(false);
  });

  it('отклоняет автопроверку неверного типа', () => {
    expect(settingsPatchSchema.safeParse({ mcpAutoCheck: 'yes' }).success).toBe(false);
  });
});

/**
 * Акцент и флаг онбординга — тоже своя копия контрактных полей. Без них в
 * серверной схеме PATCH молча выбросил бы значение, и ни выбранный акцент, ни
 * отметка о пройденном мастере не сохранились бы в state.json.
 */
describe('settingsPatchSchema — акцент и онбординг', () => {
  it('пропускает валидный пресет акцента и флаг онбординга', () => {
    const parsed = settingsPatchSchema.safeParse({ accent: 'blue', onboardingDone: true });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.accent).toBe('blue');
      expect(parsed.data.onboardingDone).toBe(true);
    }
  });

  it('пропускает все пресеты акцента', () => {
    for (const accent of ['default', 'blue', 'green', 'purple', 'amber']) {
      expect(settingsPatchSchema.safeParse({ accent }).success).toBe(true);
    }
  });

  it('отклоняет неизвестный пресет акцента', () => {
    expect(settingsPatchSchema.safeParse({ accent: 'crimson' }).success).toBe(false);
  });

  it('отклоняет акцент неверного типа', () => {
    expect(settingsPatchSchema.safeParse({ accent: 123 }).success).toBe(false);
  });

  it('отклоняет флаг онбординга неверного типа', () => {
    expect(settingsPatchSchema.safeParse({ onboardingDone: 'yes' }).success).toBe(false);
  });
});
