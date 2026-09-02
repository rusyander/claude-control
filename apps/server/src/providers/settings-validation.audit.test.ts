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
