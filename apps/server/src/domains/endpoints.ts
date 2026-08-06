import type { AppSettings, EndpointProfile, EndpointsInfo } from '@claude-control/contracts';
import type { AssistantEndpoint } from './assistant-runner.ts';
import {
  clearStoredKey,
  getStoredKey,
  maskKey,
  setStoredKey,
  MAX_KEY_LENGTH,
} from '../lib/provider-keys.ts';
import { describeEndpointTargets } from './endpoints/endpoint-plan.ts';

/**
 * Свой эндпоинт — фасад раздела.
 *
 * Панель ведёт профили (адрес + вид API + модель) и умеет три вещи: сказать,
 * какие CLI этот профиль примут и что именно в них будет записано
 * (`endpoints/endpoint-plan.ts`), проверить связь с адресом
 * (`endpoints/endpoint-probe.ts`) и применить профиль к выбранному CLI
 * (`endpoints/endpoint-apply.ts`).
 *
 * БЕЗОПАСНОСТЬ: сами профили лежат в открытом `state.json` — там только адрес,
 * вид API и имя модели, секрета в них нет. ТОКЕН хранится отдельно, в том же
 * зашифрованном хранилище, что и ключи провайдеров (AES-256-GCM, парольная
 * фраза — машинно-локальный файл 0600), наружу отдаётся только маской и
 * попадает в чужой конфиг исключительно по явной галочке пользователя.
 */

export {
  buildEndpointPlan,
  describeEndpointTargets,
  endpointApiKindsOf,
  resolveEndpointVars,
  resolveEndpointWriteTarget,
  type EndpointWriteTarget,
} from './endpoints/endpoint-plan.ts';

export {
  endpointModelsUrl,
  isLocalHost,
  parseEndpointUrl,
  probeEndpoint,
  type ProbeFetch,
} from './endpoints/endpoint-probe.ts';

export { applyEndpointProfile, EndpointApplyError } from './endpoints/endpoint-apply.ts';

/**
 * Ключ токена профиля в хранилище. Префикс отделяет их от ключей провайдеров,
 * которые лежат в том же файле под своими id: сталкиваться им нельзя, а
 * заводить второе хранилище ради этого — лишний файл с секретами на диске.
 */
export function endpointTokenId(profileId: string): string {
  return `endpoint:${profileId}`;
}

/** Расшифрованный токен профиля — только для исходящего запроса и записи в файл. */
export function readEndpointToken(appDataDir: string, profileId: string): string | undefined {
  return getStoredKey(appDataDir, endpointTokenId(profileId));
}

/** Сохранить токен профиля (зашифровано). Пустое значение — удаление. */
export function saveEndpointToken(appDataDir: string, profileId: string, token: string): boolean {
  const trimmed = token.trim();
  if (trimmed.length > MAX_KEY_LENGTH) return false;
  return setStoredKey(appDataDir, endpointTokenId(profileId), trimmed);
}

/** Забыть токен профиля. Отсутствие токена — не ошибка. */
export function clearEndpointToken(appDataDir: string, profileId: string): void {
  clearStoredKey(appDataDir, endpointTokenId(profileId));
}

/** Найти профиль по id; пусто/не найден — первый в списке (или `undefined`). */
export function findEndpointProfile(
  profiles: EndpointProfile[],
  profileId?: string,
): EndpointProfile | undefined {
  if (profileId) {
    const exact = profiles.find((item) => item.id === profileId);
    if (exact) return exact;
  }
  return profiles[0];
}

/**
 * Свой эндпоинт для ассистента САМОЙ панели — или `undefined`, когда он не
 * выбран (тогда всё как раньше: облако вендора и порядок «CLI → ключ»).
 *
 * Выбор именной: настройка хранит id профиля, а не «включено». Профиль удалили
 * — ассистент возвращается в облако, а не молча уезжает на соседний адрес.
 */
export function resolveAssistantEndpoint(
  store: EndpointSettingsSource,
  appDataDir: string,
): AssistantEndpoint | undefined {
  const settings = store.getSettings();
  const id = settings.assistantEndpointId;
  if (!id) return undefined;

  const profile = settings.endpointProfiles.find((item) => item.id === id);
  if (!profile) return undefined;

  return {
    baseUrl: profile.baseUrl,
    apiKind: profile.apiKind,
    model: profile.model,
    token: readEndpointToken(appDataDir, profile.id),
  };
}

interface EndpointSettingsSource {
  getSettings(): Pick<
    AppSettings,
    'endpointProfiles' | 'assistantEndpointId' | 'claudeDirOverride'
  >;
}

/**
 * Сводка раздела: профили, маски их токенов и готовность каждого CLI принять
 * ВЫБРАННЫЙ профиль. Готовность считается для конкретного профиля — она зависит
 * от вида API, и «поддержан вообще» без профиля ничего не значит.
 */
export function describeEndpoints(
  store: EndpointSettingsSource,
  appDataDir: string,
  claudeSettingsPath: string,
  profileId?: string,
): EndpointsInfo {
  const settings = store.getSettings();
  const profiles = settings.endpointProfiles;

  const tokenMasks: Record<string, string> = {};
  for (const profile of profiles) {
    const token = readEndpointToken(appDataDir, profile.id);
    if (token) tokenMasks[profile.id] = maskKey(token);
  }

  const active = findEndpointProfile(profiles, profileId);
  const targets = active
    ? describeEndpointTargets(
        active,
        readEndpointToken(appDataDir, active.id),
        claudeSettingsPath,
        settings.claudeDirOverride,
      )
    : [];

  return {
    profiles,
    tokenMasks,
    targets,
    activeProfileId: active?.id ?? '',
    assistantProfileId: settings.assistantEndpointId,
  };
}
