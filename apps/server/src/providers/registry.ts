import type { AppSettings, ProviderInfo, ProvidersResponse } from '@claude-control/contracts';
import { claudeProvider } from './claude.ts';
import { CATALOG_PROVIDERS } from './catalog.ts';
import type { ConfigProvider } from './types.ts';

/**
 * Реестр провайдеров конфигурации. Claude — проверенный дефолт и идёт первым;
 * далее объявлены экспериментальные (Codex, Gemini, Cursor, OpenCode, Aider) —
 * их можно ВЫБРАТЬ, но их разделы пока гейтятся (planned/unsupported) и ничего
 * не пишут. Выбор активного провайдера хранится в настройке `provider` (дефолт
 * `claude`). Незнакомый id молча откатывается на Claude — панель не должна
 * остаться без адаптера.
 */

export const DEFAULT_PROVIDER_ID = 'claude';

const ALL_PROVIDERS: ConfigProvider[] = [claudeProvider, ...CATALOG_PROVIDERS];

const PROVIDERS = new Map<string, ConfigProvider>(
  ALL_PROVIDERS.map((provider) => [provider.id, provider]),
);

/** Минимум, что нужно реестру от хранилища настроек, — без импорта AppStore. */
export interface SettingsSource {
  getSettings(): Pick<AppSettings, 'provider'>;
}

/** Все известные провайдеры (Claude первым). */
export function listProviders(): ConfigProvider[] {
  return [...PROVIDERS.values()];
}

/** Есть ли провайдер с таким id — используется валидацией настройки. */
export function isKnownProviderId(id: string): boolean {
  return PROVIDERS.has(id);
}

/** Провайдер по id; неизвестный id → Claude (fail-safe, панель не остаётся без адаптера). */
export function getProvider(id: string): ConfigProvider {
  return PROVIDERS.get(id) ?? claudeProvider;
}

/** Id активного провайдера из настроек; незнакомое значение → дефолтный claude. */
export function getActiveProviderId(store: SettingsSource): string {
  const id = store.getSettings().provider;
  return isKnownProviderId(id) ? id : DEFAULT_PROVIDER_ID;
}

/** Активный провайдер целиком. */
export function getActiveProvider(store: SettingsSource): ConfigProvider {
  return getProvider(getActiveProviderId(store));
}

/** Полезная нагрузка `GET /api/providers`: активный id и карточки провайдеров. */
export function describeProviders(store: SettingsSource): ProvidersResponse {
  return {
    active: getActiveProviderId(store),
    providers: listProviders().map((provider): ProviderInfo => ({
      id: provider.id,
      name: provider.name,
      status: provider.status,
      // Карту копируем, чтобы наружу не утёк изменяемый внутренний объект.
      capabilities: { ...provider.capabilities },
      // Модель раздела инструкций отдаём явно: у Aider это не файл, а СПИСОК
      // ссылок (`read`), у Cursor — КАТАЛОГ правил `.mdc`, и клиент должен
      // открыть свою страницу. Решать это по id провайдера значило бы зашивать
      // знание о провайдерах в клиент.
      instructionsModel: provider.instructionsList
        ? 'list'
        : provider.instructionsRules
          ? 'rules'
          : provider.instructionsFile
            ? 'file'
            : 'none',
      // Хуки и плагины — тоже МОДЕЛЬЮ, а не id провайдера. У Claude обе модели
      // свои и богатые (события settings.json / расширения самой панели), у
      // OpenCode — ключ конфига `experimental.hook` и каталог файлов + список
      // npm. Провайдер без адаптера получает `none` и до страницы не доходит
      // вовсе: его гейт всё равно вернёт заглушку (fail-closed).
      hooksModel: provider.hooksConfig ? 'config' : provider.id === 'claude' ? 'claude' : 'none',
      pluginsModel: provider.pluginsConfig ? 'files' : provider.id === 'claude' ? 'panel' : 'none',
      // Скиллы (OPENCODE-5) — тем же правилом: у Claude раздел свой и богатый, у
      // OpenCode каталог `skills/` со `SKILL.md`, у остальных раздела нет.
      skillsModel: provider.skillsConfig ? 'files' : provider.id === 'claude' ? 'claude' : 'none',
    })),
  };
}
