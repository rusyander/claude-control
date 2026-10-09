import type { AppStore } from '../../lib/app-store/app-store.ts';
import {
  localizeText,
  serverText,
  type ServerTextCode,
  type TextParams,
} from '../../lib/server-texts/server-texts.ts';
import { claudeProvider } from '../../providers/claude.ts';
import { getActiveProvider } from '../../providers/registry.ts';
import { claudeContourEnv, contourUnreachable } from '../panel-agent/launch.ts';

/**
 * Чем пойдёт разбор фонового наблюдателя — решение ДО запуска, без сети и без
 * записи, на КАЖДЫЙ разбор: галочка контура, снятая минуту назад, уже действует.
 *
 * До этого модуля наблюдатель всегда запускал `claude` в облако вендора, какой
 * бы CLI ни был активен и куда бы ни шёл «Ассистент панели»: человек, сведший
 * панель в контур, получал разбор кода панели мимо контура. Теперь:
 *
 * - разбор всегда запускает `claude`: запуск «только чтение» (`--tools`,
 *   `--allowedTools`, снятие слоёв) описан и проверен лишь у Claude Code;
 * - Claude без профиля ассистента — прежний путь, облако вендора по подписке;
 *   Claude, уведённый переключателем на локальную модель, — его окружением;
 * - профиль контура — окружение ОДНОГО процесса тем же построителем, что у
 *   агента панели (`claudeContourEnv`), и без `--model`: дешёвую ступень
 *   вендора контур отклонил бы 403 «модель», модель задаёт профиль;
 * - свой эндпоинт — отказ: его токен пришлось бы отдать процессу CLI;
 * - активен чужой CLI — решает, КУДА уйдёт разбор (владелец 09.10.2026: «выбран
 *   Qwen на локальной модели — наблюдатель тоже идёт через Qwen»). Контур или
 *   локальная модель — разбор идёт: отвечает та же модель, что у агентов, и
 *   код панели не покидает выбранного маршрута. Облако Claude — честный отказ:
 *   подставить его вместо выбранного CLI значит уйти туда, куда человек не звал.
 */

export interface WatcherRouteDeps {
  store: AppStore;
  appDataDir: string;
  /** Порт живого шлюза; 0 — не поднят. */
  gatewayPort: () => number;
  detect?: (command: string) => boolean;
  /** Окружение переключателя «Claude Code на локальной модели» — см. `PanelAgentLaunchDeps`. */
  claudeSwitchEnv?: () => Record<string, string>;
}

export type WatcherRoute =
  | {
      ok: true;
      /** Добавка к окружению процесса; ключа контура среди неё нет никогда. */
      env: Record<string, string>;
      /** Через контур: модель задаёт профиль, `--model` вендора не передаётся. */
      viaContour: boolean;
    }
  | {
      ok: false;
      messageCode: ServerTextCode;
      params: TextParams;
      /** Русский текст по коду — запасной для клиента, не знающего кода. */
      message: string;
    };

function refuse(messageCode: ServerTextCode, params: TextParams): WatcherRoute {
  return { ok: false, messageCode, params, message: serverText(messageCode, params) };
}

export function resolveWatcherRoute(deps: WatcherRouteDeps): WatcherRoute {
  const provider = getActiveProvider(deps.store);
  const foreign = provider.id !== claudeProvider.id;
  const settings = deps.store.getSettings();
  const profile = settings.assistantEndpointId
    ? (settings.endpointProfiles ?? []).find((item) => item.id === settings.assistantEndpointId)
    : undefined;
  // Выбранного профиля больше нет — как у ассистента: облако вендора по умолчанию.
  // Уведённый переключателем Claude — его окружением: `--model haiku` наблюдателя
  // переводит в локальную модель `ANTHROPIC_DEFAULT_HAIKU_MODEL` того же набора.
  if (!profile) {
    const env = deps.claudeSwitchEnv?.() ?? {};
    // Переключатель пишет адрес только локального сервера: есть адрес — разбор
    // уходит в локальную модель, нет — в облако Claude, куда чужой CLI не звал.
    if (foreign && !env.ANTHROPIC_BASE_URL) {
      return refuse('watcher-provider-unsupported', { provider: provider.name });
    }
    return { ok: true, env, viaContour: false };
  }
  if (!profile.ownerPlatformId)
    return refuse('watcher-endpoint-unsupported', { name: profile.name });

  const down = contourUnreachable(deps, profile.ownerPlatformId);
  if (down) {
    return refuse(
      down.cause === 'gateway_down'
        ? 'assistant-contour-gateway-down'
        : 'assistant-contour-no-token',
      { title: down.title },
    );
  }
  // Окружение — тем же построителем, что у агента панели, но без его проверки
  // активного CLI: агент идёт CLI человека, а разбор — всегда `claude`.
  const env = claudeContourEnv(profile, profile.ownerPlatformId, deps.gatewayPort());
  if (!env) {
    return refuse('assistant-route-refused', {
      reason: 'У Claude Code не описан адрес шлюза — контур не применить.',
    });
  }
  return { ok: true, env, viaContour: true };
}

/** Текст отказа на языке панели — в `detail` проблемы наблюдателя. */
export function watcherRefusalDetail(
  route: Extract<WatcherRoute, { ok: false }>,
  language: 'ru' | 'en',
): string {
  return localizeText(route.message, language);
}
