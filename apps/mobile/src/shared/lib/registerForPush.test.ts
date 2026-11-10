import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../config/i18n/en';
import { ru } from '../config/i18n/ru';

/**
 * Push телефона (этап 12, M2): идентификатор проекта EAS приходит из окружения СБОРКИ
 * (`AGENTDECK_EAS_PROJECT_ID` → `extra.eas.projectId` в `app.config.js`), файл Firebase — так же
 * (`AGENTDECK_GOOGLE_SERVICES` → `android.googleServicesFile`). Без идентификатора приложение
 * говорит «Пуш не настроен», а не зовёт `eas init`. Настоящие: `app.config.js` и
 * `registerForPush`; подменены нативные модули (expo-notifications, expo-constants,
 * react-native) и сеть панели.
 */

const native = vi.hoisted(() => ({
  extra: undefined as Record<string, unknown> | undefined,
  tokenFor: vi.fn(async (_options: { projectId: string }) => ({ data: 'ExponentPushToken[t]' })),
  post: vi.fn(async () => ({})),
}));

vi.mock('expo-notifications', () => ({
  getPermissionsAsync: async () => ({ status: 'granted' }),
  requestPermissionsAsync: async () => ({ status: 'granted' }),
  getExpoPushTokenAsync: native.tokenFor,
}));
vi.mock('expo-constants', () => ({
  default: {
    get expoConfig() {
      return { extra: native.extra };
    },
    easConfig: undefined,
  },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('./ensureChannel', () => ({ ensureChannel: async () => undefined }));
vi.mock('../api/client', () => ({ api: { post: native.post } }));
vi.mock('../config/i18n', () => ({ dict: () => ru }));

const { registerForPush } = await import('./registerForPush');

const require = createRequire(import.meta.url);
/** Тот самый `app.config.js`, что читает Expo при сборке: функция от окружения процесса. */
const appConfig = require('../../../app.config.js') as () => {
  extra: { eas?: { projectId?: string }; defaultPanelUrl: string };
  android: { googleServicesFile?: string; package: string };
};

const ENV_KEYS = ['AGENTDECK_EAS_PROJECT_ID', 'AGENTDECK_GOOGLE_SERVICES'] as const;

describe('push setup: projectId and Firebase file from the build environment, «push not set up» without them', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) vi.stubEnv(key, '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    native.extra = undefined;
  });

  it('app.config.js: no variables → no extra.eas.projectId and no googleServicesFile', () => {
    const config = appConfig();
    expect(config.extra.eas?.projectId).toBeUndefined();
    expect(config.android.googleServicesFile).toBeUndefined();
    expect(config.android.package).toBe('ai.agentdeck.panel');
  });

  it('app.config.js: the variables land in extra.eas.projectId and android.googleServicesFile as given', () => {
    vi.stubEnv('AGENTDECK_EAS_PROJECT_ID', ' 0f0e0d0c-1111-4222-8333-444455556666 ');
    vi.stubEnv('AGENTDECK_GOOGLE_SERVICES', './secrets/google-services.json');
    const config = appConfig();
    expect(config.extra.eas?.projectId).toBe('0f0e0d0c-1111-4222-8333-444455556666');
    expect(config.android.googleServicesFile).toBe('./secrets/google-services.json');
    // Другой идентификатор — другой результат: значение берётся из окружения, не вшито.
    vi.stubEnv('AGENTDECK_EAS_PROJECT_ID', 'aaaaaaaa-0000-4000-8000-000000000000');
    expect(appConfig().extra.eas?.projectId).toBe('aaaaaaaa-0000-4000-8000-000000000000');
  });

  it('registerForPush without a projectId → «Пуш не настроен…», no token asked, nothing sent to the panel', async () => {
    native.extra = appConfig().extra;
    const result = await registerForPush('Pixel');
    expect(result).toEqual({ token: '', problem: ru.push.noProjectId });
    expect(ru.push.noProjectId).toMatch(/^Пуш не настроен/);
    expect(en.push.noProjectId).toMatch(/^Push is not set up/);
    expect(native.tokenFor).not.toHaveBeenCalled();
    expect(native.post).not.toHaveBeenCalled();
  });

  it('registerForPush with the projectId of the build → token for that project, device registered at the panel', async () => {
    vi.stubEnv('AGENTDECK_EAS_PROJECT_ID', '0f0e0d0c-1111-4222-8333-444455556666');
    native.extra = appConfig().extra;
    const result = await registerForPush('Pixel');
    expect(result).toEqual({ token: 'ExponentPushToken[t]' });
    expect(native.tokenFor).toHaveBeenCalledWith({
      projectId: '0f0e0d0c-1111-4222-8333-444455556666',
    });
    expect(native.post).toHaveBeenCalledWith('/remote/devices', {
      token: 'ExponentPushToken[t]',
      platform: 'android',
      label: 'Pixel',
    });
  });
});
