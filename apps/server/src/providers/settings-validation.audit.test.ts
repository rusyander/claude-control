import { describe, it, expect } from 'vitest';
import { settingsPatchSchema, importStateSchema } from './settings-validation.ts';

/**
 * Аудит «Настройки» 2026-09-03: поля, которые схема раньше молча вырезала.
 * Клиент слал PATCH с тумблером инициативы, получал 200 со старым значением —
 * и тумблер отскакивал; импорт снимка терял связи чатов и спаренные телефоны.
 */
describe('settings-validation: поля аудита', () => {
  it('PATCH принимает инициативы чата, а удалённый доступ по-прежнему отбрасывает', () => {
    const parsed = settingsPatchSchema.safeParse({
      taskSplitInitiative: true,
      handoffInitiative: false,
      handoffContextLimit: 150_000,
      handoffAutoDefault: true,
      remoteAccess: { enabled: true, publicUrl: 'https://x.example', notify: false },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.taskSplitInitiative).toBe(true);
      expect(parsed.data.handoffContextLimit).toBe(150_000);
      // Единственный писатель удалённого доступа — /api/remote.
      expect('remoteAccess' in parsed.data).toBe(false);
    }
  });

  it('импорт снимка сохраняет удалённый доступ', () => {
    const parsed = importStateSchema.safeParse({
      settings: { remoteAccess: { enabled: true, publicUrl: 'https://x.example', notify: false } },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.settings?.remoteAccess).toEqual({
        enabled: true,
        publicUrl: 'https://x.example',
        notify: false,
      });
    }
  });

  it('PATCH отклоняет отрицательный порог передачи', () => {
    expect(settingsPatchSchema.safeParse({ handoffContextLimit: -1 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ handoffContextLimit: 1.5 }).success).toBe(false);
  });

  it('импорт сохраняет связи чатов, здоровье MCP, окна кода и телефоны', () => {
    const snapshot = {
      chatLinks: { 'chat-1': { sessionId: 's1' } },
      mcpHealth: { github: { status: 'ok', checkedAt: '2026-09-03T00:00:00.000Z' } },
      projectCodeViews: { 'c:/repo': { open: ['a.ts'] } },
      projectCodeLayout: { split: 0.4 },
      pushDevices: [{ token: 'dev-1', platform: 'android', registeredAt: '2026-09-01T00:00:00Z' }],
    };
    const parsed = importStateSchema.safeParse(snapshot);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.chatLinks).toEqual(snapshot.chatLinks);
      expect(parsed.data.mcpHealth).toEqual(snapshot.mcpHealth);
      expect(parsed.data.projectCodeViews).toEqual(snapshot.projectCodeViews);
      expect(parsed.data.projectCodeLayout).toEqual(snapshot.projectCodeLayout);
      expect(parsed.data.pushDevices).toEqual(snapshot.pushDevices);
    }
  });
});

/**
 * Контуры едут через тот же PATCH настроек, и та же ошибка стоила бы того же:
 * поле, которого нет в схеме, вырезается молча — панель ответила бы 200, а на
 * первом F5 раздел «Контур» откатился бы к прежнему состоянию.
 */
describe('settings-validation: контуры', () => {
  const platform = {
    id: 'enterprise-platform-dev',
    title: 'EnterprisePlatform · dev',
    driver: 'enterprise-platform',
    baseUrl: 'https://api.dev.example.ru',
    enabled: true,
    mode: 'required',
    budgetUsd: 100,
    capabilities: ['models', 'chat'],
    targets: ['assistant'],
    projectPaths: ['c:/repo'],
    // Список агентов ведёт человек, и через PATCH он ездит так же, как всё
    // остальное: поле, забытое в схеме, вырезалось бы молча — панель ответила
    // бы 200, а на первом F5 агенты пропали бы.
    agents: [{ id: '0f4b2a10-77c3-4d1e-9f0a-2b6c8d5e1a33', title: 'Юрист компании' }],
    budgetSince: '2026-09-01',
    caCertPath: 'c:/certs/corp-root.pem',
  };

  it('PATCH проносит контур целиком, поле в поле', () => {
    const parsed = settingsPatchSchema.safeParse({ platforms: [platform] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.platforms).toEqual([platform]);
  });

  it('ключ внутри настройки вырезается: секрет не ездит через PATCH настроек', () => {
    const parsed = settingsPatchSchema.safeParse({
      platforms: [{ ...platform, token: 'sk-СЕКРЕТ-4f21' }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(JSON.stringify(parsed.data)).not.toContain('sk-СЕКРЕТ-4f21');
  });

  // Контур, настроенный до Т7, поля `agents` не знает вовсе. Отказ на нём стоил
  // бы всего PATCH настроек: раздел откатывался бы на первом же сохранении.
  it('контур без списка агентов проходит: у настроенных до Т7 поля нет', () => {
    const { agents: _agents, ...older } = platform;
    const parsed = settingsPatchSchema.safeParse({ platforms: [older] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.platforms?.[0]?.agents).toEqual([]);
  });

  // То же самое про Т8: у контура, настроенного раньше, дня начала периода нет.
  it('контур без дня начала периода проходит: у настроенных до Т8 поля нет', () => {
    const { budgetSince: _since, ...older } = platform;
    const parsed = settingsPatchSchema.safeParse({ platforms: [older] });
    expect(parsed.success).toBe(true);
    // Пусто означает «с начала учёта», а не выдуманную за человека дату.
    if (parsed.success) expect(parsed.data.platforms?.[0]?.budgetSince).toBe('');
  });

  it('дата периода не в виде ГГГГ-ММ-ДД — отказ: иначе она молча отрезала бы расход', () => {
    // Дни учёта сравниваются посимвольно: «01.09.2026» меньше любого из них, и
    // человек увидел бы честный ноль там, где потрачено.
    expect(
      settingsPatchSchema.safeParse({ platforms: [{ ...platform, budgetSince: '01.09.2026' }] })
        .success,
    ).toBe(false);
  });

  // Найдено враждебным ревью Т8: `2026-13-45` проходит по виду, но такого дня
  // нет — сравнение строк не нашло бы ни одного дня расхода, и карточка тихо
  // показывала бы ноль при растущем счёте.
  it('несуществующий день — отказ: по виду он проходит, а расход обнуляет', () => {
    for (const day of ['2026-13-45', '2026-02-31', '0000-00-00']) {
      expect(
        settingsPatchSchema.safeParse({ platforms: [{ ...platform, budgetSince: day }] }).success,
      ).toBe(false);
    }
  });

  // Та же пара, что у `budgetSince`: у контура, настроенного до Т8, бюджета в
  // записи нет, и отказ стоил бы всего PATCH настроек.
  it('контур без бюджета проходит, и бюджет становится нулём — «не следить»', () => {
    const { budgetUsd: _budget, ...older } = platform;
    const parsed = settingsPatchSchema.safeParse({ platforms: [older] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.platforms?.[0]?.budgetUsd).toBe(0);
  });

  it('неизвестный драйвер и отрицательный бюджет — отказ, а не тихая правка', () => {
    expect(
      settingsPatchSchema.safeParse({ platforms: [{ ...platform, driver: 'самодельный' }] })
        .success,
    ).toBe(false);
    expect(
      settingsPatchSchema.safeParse({ platforms: [{ ...platform, budgetUsd: -1 }] }).success,
    ).toBe(false);
  });

  it('импорт снимка сохраняет итог последней пробы контура', () => {
    const platformHealth = {
      'enterprise-platform-dev': { outcome: 'ok', checkedAt: '2026-09-09T00:00:00.000Z' },
    };
    const parsed = importStateSchema.safeParse({
      settings: { platforms: [platform] },
      platformHealth,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.platformHealth).toEqual(platformHealth);
      expect(parsed.data.settings?.platforms).toEqual([platform]);
    }
  });
});
