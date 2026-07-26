import { describe, it, expect } from 'vitest';
import { settingsPatchSchema, importStateSchema } from './settings-validation.ts';

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

/**
 * Провайдер конфигурации: валидное значение сверяется с реестром. Известны
 * claude и объявленные экспериментальные (codex и др.); по-настоящему незнакомый
 * id отклоняется, чтобы не осесть в state.json.
 */
describe('settingsPatchSchema — провайдер', () => {
  it('пропускает известного провайдера claude', () => {
    const parsed = settingsPatchSchema.safeParse({ provider: 'claude' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.provider).toBe('claude');
  });

  it('пропускает объявленного экспериментального провайдера codex', () => {
    const parsed = settingsPatchSchema.safeParse({ provider: 'codex' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.provider).toBe('codex');
  });

  it('отклоняет по-настоящему неизвестного провайдера', () => {
    expect(settingsPatchSchema.safeParse({ provider: 'nonexistent' }).success).toBe(false);
  });

  it('отклоняет провайдера неверного типа', () => {
    expect(settingsPatchSchema.safeParse({ provider: 123 }).success).toBe(false);
  });
});

/**
 * Регрессия про ДЕНЬГИ. Прайс держит ДВЕ ставки записи кэша: пятиминутную и
 * часовую (последняя в 1.6 раза дороже), и на реальных транскриптах часовым
 * кэшем пишется 99% объёма. Схема знала четыре поля — zod срезал часовую ставку
 * из своей цены пользователя, она не доезжала до state.json, а расчёт домножал
 * введённую пятиминутную на 1.6: набранные $6.25 превращались в счёте в $10.
 */
describe('settingsPatchSchema — своя часовая ставка кэша', () => {
  const price = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

  it('часовая ставка доезжает до настроек, а не срезается схемой', () => {
    const parsed = settingsPatchSchema.safeParse({
      modelPricing: { 'claude-opus-4-8': { ...price, cacheWrite1h: 7 } },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.modelPricing?.['claude-opus-4-8']).toEqual({ ...price, cacheWrite1h: 7 });
  });

  it('часовая ставка необязательна — прежние свои цены остаются валидными', () => {
    const parsed = settingsPatchSchema.safeParse({ modelPricing: { opus: price } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.modelPricing?.opus).toEqual(price);
  });

  it('отрицательная часовая ставка отклоняется', () => {
    expect(
      settingsPatchSchema.safeParse({ modelPricing: { opus: { ...price, cacheWrite1h: -1 } } })
        .success,
    ).toBe(false);
  });
});

/**
 * Импорт снимка с другой машины. zod вырезает всё, чего в схеме нет, поэтому
 * каждое поле состояния обязано быть в ней перечислено: без этого перенос
 * МОЛЧА терял часть настроек — пользователь видел «импортировано» и пустой
 * список проектов.
 */
describe('importStateSchema — ничего не теряется при переносе', () => {
  it('пропускает список проектов, команды и настройки запуска, отметки провайдеров', () => {
    const parsed = importStateSchema.safeParse({
      projects: [{ path: 'c:/work/app', name: 'app' }],
      runnerCommands: { 'c:/work/app': 'pnpm dev' },
      runnerPrefs: { 'c:/work/app': { autostart: true, pinnedPort: 5173 } },
      providerChecks: { codex: { status: 'ok' } },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.projects).toHaveLength(1);
    expect(parsed.data.runnerCommands).toEqual({ 'c:/work/app': 'pnpm dev' });
    expect(parsed.data.runnerPrefs?.['c:/work/app']).toBeDefined();
    expect(parsed.data.providerChecks?.codex).toBeDefined();
  });

  it('отпечаток парольной фразы НЕ переносится: чужой заблокировал бы шифрование навсегда', () => {
    const parsed = importStateSchema.safeParse({ secretBackupVerifier: 'чужой-отпечаток' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect('secretBackupVerifier' in parsed.data).toBe(false);
  });

  it('отклоняет команды запуска неверного типа', () => {
    expect(importStateSchema.safeParse({ runnerCommands: { 'c:/work': 42 } }).success).toBe(false);
  });
});
