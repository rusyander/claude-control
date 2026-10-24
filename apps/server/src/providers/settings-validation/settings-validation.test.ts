import { describe, it, expect } from 'vitest';
import { settingsPatchSchema, importStateSchema } from './settings-validation.ts';
import { NOTIFY_EVENTS } from '@agentdeck/contracts/integrations';
import { importStateSchema as contractImportStateSchema } from '@agentdeck/contracts';

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

  /**
   * Подписка уведомлений перечислена и в контракте, и здесь. Пока это были две
   * списанные копии, добавленное событие («бюджет») попало только в одну — и
   * собственный снимок панели переставал импортироваться обратно: экспорт писал
   * значение по умолчанию, которого импорт не знал. Проверяем КАЖДОЕ событие
   * поимённо, а не длину списка: список один, разъехаться ему негде.
   */
  it('импорт знает каждое событие подписки — и телеграма, и вебхука', () => {
    for (const event of NOTIFY_EVENTS) {
      const parsed = importStateSchema.safeParse({
        settings: {
          integrations: {
            jira: { enabled: false, baseUrl: '', email: '', deployment: '' },
            gitlab: { enabled: false, baseUrl: '', repo: '' },
            testit: { enabled: false, baseUrl: '', projectKey: '', groupId: '' },
            ci: { enabled: false, kind: '', repo: '', workflow: '', artifact: '' },
            telegram: { enabled: false, chatId: '', events: [event] },
            webhook: { enabled: false, url: '', events: [event] },
          },
        },
      });
      expect(parsed.success ? 'ok' : `${event}: ${JSON.stringify(parsed.error.issues)}`).toBe('ok');
    }
  });
});

describe('settingsPatchSchema — экономия групп', () => {
  const economy = {
    compactWindow: 160_000,
    bashOutputChars: 8_000,
    readOutputTokens: 10_000,
    cacheTtl: '',
    detachIde: true,
    sonnetDeliver: true,
    freshOnColdResume: true,
    workHabits: true,
  };

  it('блок доезжает целиком: без ключа в схеме тумблер отскакивал бы назад', () => {
    const parsed = settingsPatchSchema.safeParse({ groupEconomy: { ...economy, cacheTtl: '5m' } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.groupEconomy).toEqual({ ...economy, cacheTtl: '5m' });
  });

  it('ноль — «решает CLI», в границах — да, за границами CLI — нет', () => {
    const ok = (patch: Partial<typeof economy>) =>
      settingsPatchSchema.safeParse({ groupEconomy: { ...economy, ...patch } }).success;
    expect(ok({ compactWindow: 0, bashOutputChars: 0, readOutputTokens: 0 })).toBe(true);
    expect(ok({ compactWindow: 100_000, bashOutputChars: 128_000 })).toBe(true);
    expect(ok({ compactWindow: 99_999 })).toBe(false);
    expect(ok({ bashOutputChars: 3_999 })).toBe(false);
    expect(ok({ bashOutputChars: 128_001 })).toBe(false);
    expect(ok({ readOutputTokens: 100_001 })).toBe(false);
    expect(ok({ cacheTtl: '10m' as never })).toBe(false);
  });

  it('правка одного ключа проходит без остальных: целый блок со снимка страницы затирал соседнюю', () => {
    const parsed = settingsPatchSchema.safeParse({ groupEconomy: { sonnetDeliver: false } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.groupEconomy).toEqual({ sonnetDeliver: false });
    // Границы держатся и у одиночного ключа.
    expect(
      settingsPatchSchema.safeParse({ groupEconomy: { bashOutputChars: 3_999 } }).success,
    ).toBe(false);
  });
});

describe('settingsPatchSchema — сторож групп', () => {
  it('один порог проходит без остальных и без подстановки умолчаний', () => {
    // zod 4 подставляет умолчание и под `.partial()`: правка одного порога
    // молча вернула бы остальные к заводским поверх сохранённых.
    const parsed = settingsPatchSchema.safeParse({ groupWatch: { stallMinutes: 30 } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.groupWatch).toEqual({ stallMinutes: 30 });
  });

  it('границы порогов держатся', () => {
    const ok = (groupWatch: Record<string, unknown>) =>
      settingsPatchSchema.safeParse({ groupWatch }).success;
    expect(ok({ enabled: false })).toBe(true);
    expect(ok({ stallMinutes: 0 })).toBe(false);
    expect(ok({ checkRepeats: 1 })).toBe(false);
    expect(ok({ coldContextTokens: 9_999 })).toBe(false);
    expect(ok({ projectionPercent: 101 })).toBe(false);
    expect(ok({ askMinutes: 2.5 })).toBe(false);
    // Крайние допустимые — проходят: сдвиг границы внутрь виден.
    expect(ok({ stallMinutes: 1, checkRepeats: 2, rereadRepeats: 2 })).toBe(true);
    expect(ok({ coldContextTokens: 10_000, projectionPercent: 100, cooldownMinutes: 1_440 })).toBe(
      true,
    );
  });

  it('снимок с отличиями сторожа импортируется', () => {
    const parsed = importStateSchema.safeParse({ settings: { groupWatch: { askMinutes: 40 } } });
    expect(parsed.success).toBe(true);
  });

  // F-55: снимок другой версии с порогом вне нынешних границ не отвергается целиком.
  it('битый порог и старый ключ сторожа в снимке отбрасываются поштучно, остальное принимается', () => {
    const parsed = importStateSchema.safeParse({
      settings: {
        backupKeep: 3,
        groupWatch: { stallMinutes: 0, askMinutes: 40, telegram: false, checkRepeats: 'x' },
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.settings?.groupWatch).toEqual({ askMinutes: 40 });
      expect(parsed.data.settings?.backupKeep).toBe(3);
    }
    // Не объект — структурный мусор: снимок отвергается, как с любым кривым блоком.
    expect(importStateSchema.safeParse({ settings: { groupWatch: 'off' } }).success).toBe(false);
  });

  // F-57: контрактная схема импорта state.json проверяет блок сторожа тем же объявлением.
  it('контрактный importStateSchema разбирает сторожа той же схемой снимка', () => {
    const parsed = contractImportStateSchema.safeParse({
      settings: { groupWatch: { stallMinutes: 0, askMinutes: 40 } },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.settings?.groupWatch).toEqual({ askMinutes: 40 });
  });
});
