import type { PanelAgentRunRefusalCode } from '@agentdeck/contracts/panel-agent';
import type { ServerMessageCode } from '@agentdeck/contracts/server-messages';
import type { EndpointProfile } from '@agentdeck/contracts';
import { PLATFORM_ASSISTANT_CONSUMER } from '@agentdeck/contracts/platform-consumers';
import type { AppStore } from '../../lib/app-store/app-store.ts';
import { claudeProvider } from '../../providers/claude.ts';
import { detectCliOnPath, findCliOnPath } from '../../providers/detect/detect.ts';
import { providerCliCandidates } from '../../providers/cli/cli.ts';
import { getActiveProvider } from '../../providers/registry.ts';
import { buildEndpointPlan } from '../endpoints/endpoint-plan.ts';
import { PLACEHOLDER_KEY } from '../platform/apply/profile.ts';
import { targetProfile } from '../platform/apply/targets.ts';
import { contourRunPrompt } from '../platform/routing/routing.ts';
import { readPlatforms, readToken } from '../platform/store/store.ts';
import { panelAgentDialectOf, type PanelAgentDialect } from './foreign-cli/foreign-cli.ts';

/**
 * Чем пойдёт ход агента панели — решение ДО запуска, без сети и без записи.
 *
 * Потребитель контура у агента тот же, что у ассистента панели: выбор живёт в
 * `assistantEndpointId` (его пишет применение контура с галочкой «Ассистент
 * панели» и снимает снятая галочка, `platform/store.ts → detachAssistantIfOff`).
 * Второго переключателя «агент через контур» нет намеренно: две настройки одного
 * маршрута разошлись бы, и человек, снявший галочку, получил бы агента в контуре.
 *
 * Разница с ассистентом одна, и она в транспорте: ассистент ходит в профиль
 * прямым запросом, а агенту нужны инструменты MCP — значит, CLI. Поэтому
 * профиль контура превращается в окружение ОДНОГО процесса `claude` тем же
 * построителем, каким контур пишется в файлы (`buildEndpointPlan` над
 * `targetProfile`), с заглушкой вместо ключа — ключ подставляет шлюз.
 */

export interface PanelAgentLaunchDeps {
  store: AppStore;
  appDataDir: string;
  /** Порт живого шлюза; 0 — не поднят. */
  gatewayPort: () => number;
  detect?: (command: string) => boolean;
  /**
   * Окружение переключателя «Claude Code на локальной модели» (пусто — выключен).
   * Лёгкое окно снимает слой `user`, а переключатель живёт именно в settings.json:
   * без этих переменных агент при уведённом Claude ушёл бы в облако.
   */
  claudeSwitchEnv?: () => Record<string, string>;
}

export type PanelAgentLaunch =
  | {
      ok: true;
      providerId: string;
      /** Чей CLI запускается — от этого argv и разбор вывода (`foreign-cli.ts`). */
      dialect: PanelAgentDialect;
      command: string;
      /** Добавка к окружению процесса. Ключа контура среди неё нет никогда. */
      env: Record<string, string>;
      contourId?: string;
      /**
       * Промпт контура, как у прогона чата через контур (`contourRunPrompt`):
       * без него модель контура назвала бы себя Claude. Пусто — промпт снят.
       */
      contourPrompt?: string;
    }
  | {
      ok: false;
      code: PanelAgentRunRefusalCode;
      message: string;
      /** Текст с кодом — клиент покажет его на своём языке с именем провайдера. */
      messageCode?: ServerMessageCode;
      params?: Record<string, string>;
    };

function refuse(code: PanelAgentRunRefusalCode, message: string): PanelAgentLaunch {
  return { ok: false, code, message };
}

function refuseCoded(
  code: PanelAgentRunRefusalCode,
  message: string,
  messageCode: ServerMessageCode,
  params: Record<string, string>,
): PanelAgentLaunch {
  return { ok: false, code, message, messageCode, params };
}

/**
 * Почему до контура профиля ассистента сейчас не дойти: шлюз не поднят или ключ
 * не сохранён; undefined — дойти есть чем.
 *
 * Одна проверка на всех, кто идёт профилем «Ассистент панели» (агент панели,
 * помощники формы и структуры, фоновый наблюдатель): вторая копия разошлась бы
 * с первой на первом же новом условии, и один из них ушёл бы в облако вендора,
 * пока остальные честно отказывают.
 */
export function contourUnreachable(
  deps: Pick<PanelAgentLaunchDeps, 'store' | 'appDataDir' | 'gatewayPort'>,
  platformId: string,
): { cause: 'gateway_down' | 'no_token'; title: string } | undefined {
  const title =
    readPlatforms(deps.store).find((item) => item.id === platformId)?.title ?? platformId;
  if (deps.gatewayPort() <= 0) return { cause: 'gateway_down', title };
  // Ключ читается только чтобы ответить «он есть»: в процесс уходит заглушка.
  if (!readToken(deps.appDataDir, platformId)) return { cause: 'no_token', title };
  return undefined;
}

/**
 * Окружение одного процесса `claude`, ведущее его через шлюз контура профиля
 * «Ассистента панели». Отдельной функцией потому, что его строят двое — агент
 * панели и наблюдатель (`watcher/route.ts`), — и два построителя одного
 * маршрута разошлись бы на первом же новом поле профиля. `undefined` — у
 * Claude Code не описан адрес шлюза.
 */
export function claudeContourEnv(
  profile: EndpointProfile,
  platformId: string,
  port: number,
): Record<string, string> | undefined {
  const vars = claudeProvider.endpointConfig?.anthropic;
  if (!vars) return undefined;
  const env: Record<string, string> = {};
  for (const item of buildEndpointPlan(
    // Раздел «Ассистент» в адресе: закрыли его на контуре — шлюз откажет и
    // уже идущему разговору агента, а не только следующему запуску.
    targetProfile(profile, platformId, port, 'anthropic', {
      section: PLATFORM_ASSISTANT_CONSUMER,
    }),
    vars,
    PLACEHOLDER_KEY,
    false,
  )) {
    env[item.key] = item.value;
  }
  return env;
}

export function resolvePanelAgentLaunch(deps: PanelAgentLaunchDeps): PanelAgentLaunch {
  const provider = getActiveProvider(deps.store);
  // Агент идёт CLI выбранного провайдера (Claude, Qwen Code, Codex, Gemini CLI,
  // OpenCode, Goose, Kimi Code) — у них
  // есть запуск, где у агента только переходник панели (`foreign-cli.ts`). У
  // прочих такого запуска нет — честный отказ с именем CLI, а не Claude молчком.
  const dialect = panelAgentDialectOf(provider.id);
  if (dialect === undefined) {
    return refuseCoded(
      'provider_unsupported',
      `Агент панели не работает с ${provider.name}: у этого CLI нет запуска, в котором агент действует только инструментами панели. Агент работает с Claude Code, Qwen Code, Codex, Gemini CLI, OpenCode, Goose и Kimi Code.`,
      'panel-agent-provider-unsupported',
      { provider: provider.name },
    );
  }

  const command = findCliOnPath(providerCliCandidates(provider), deps.detect ?? detectCliOnPath);
  if (command === undefined) {
    return refuseCoded(
      'cli_not_found',
      `${provider.name} не найден в PATH процесса панели — агенту нечем работать. Без CLI у агента нет инструментов панели, ключ API здесь не поможет.`,
      'panel-agent-cli-not-found',
      { provider: provider.name },
    );
  }

  const settings = deps.store.getSettings();
  const profile = settings.assistantEndpointId
    ? settings.endpointProfiles.find((item) => item.id === settings.assistantEndpointId)
    : undefined;
  // Выбранного профиля больше нет — как у ассистента: облако вендора по умолчанию,
  // а если Claude уведён переключателем на локальную модель — туда же, куда и он.
  if (!profile) {
    const env = dialect === 'claude' ? (deps.claudeSwitchEnv?.() ?? {}) : {};
    return { ok: true, providerId: provider.id, dialect, command, env };
  }

  if (!profile.ownerPlatformId) {
    return refuse(
      'endpoint_unsupported',
      `Ассистенту панели выбран свой эндпоинт «${profile.name}». Агенту пришлось бы отдать его токен процессу CLI — этого панель не делает. Верните ассистента на провайдера по умолчанию или на контур.`,
    );
  }

  // Контур у агента собирается окружением `claude` (ниже); для чужого CLI такой
  // сборки нет — отказ, а не ход в облако вендора мимо выбранного контура.
  if (dialect !== 'claude') {
    return refuseCoded(
      'provider_unsupported',
      `Через контур агент панели ходит только с Claude Code, а активный CLI — ${provider.name}. Ход не запущен, чтобы не уйти в облако вендора.`,
      'panel-agent-contour-foreign',
      { provider: provider.name },
    );
  }
  const platformId = profile.ownerPlatformId;
  const platform = readPlatforms(deps.store).find((item) => item.id === platformId);
  const unreachable = contourUnreachable(deps, platformId);
  if (unreachable?.cause === 'gateway_down') {
    return refuse(
      'contour_unreachable',
      `Агент панели идёт через контур «${unreachable.title}», а шлюз панели не поднят — ход не запущен, чтобы не уйти в облако вендора. Нажмите «Поднять шлюз» на карточке контура.`,
    );
  }
  if (unreachable) {
    return refuse(
      'contour_unreachable',
      `Агент панели идёт через контур «${unreachable.title}», а ключ контура не сохранён — шлюзу нечего подставить. Сохраните ключ на карточке контура.`,
    );
  }
  const env = claudeContourEnv(profile, platformId, deps.gatewayPort());
  if (!env) {
    return refuse(
      'provider_unsupported',
      'У Claude Code не описан адрес шлюза — контур не применить.',
    );
  }
  // Слои у агента сняты всегда (лёгкое окно, `lightWindowLayers`) — строже любой
  // галочки контура, поэтому правила слоёв контура здесь ничего не добавляют.
  const contourPrompt = platform
    ? contourRunPrompt(deps.appDataDir, platform, profile.model).trim()
    : '';
  return {
    ok: true,
    providerId: provider.id,
    dialect,
    command,
    env,
    contourId: platformId,
    ...(contourPrompt ? { contourPrompt } : {}),
  };
}
