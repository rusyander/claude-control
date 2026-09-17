import type { PanelAgentRunRefusalCode } from '@agentdeck/contracts/panel-agent';
import type { AppStore } from '../../lib/app-store.ts';
import { claudeProvider } from '../../providers/claude.ts';
import { detectCliOnPath, findCliOnPath } from '../../providers/detect.ts';
import { providerCliCandidates } from '../../providers/cli.ts';
import { getActiveProvider } from '../../providers/registry.ts';
import { buildEndpointPlan } from '../endpoints/endpoint-plan.ts';
import { PLACEHOLDER_KEY } from '../platform/apply/profile.ts';
import { targetProfile } from '../platform/apply/targets.ts';
import { contourRunPrompt } from '../platform/routing.ts';
import { readPlatforms, readToken } from '../platform/store.ts';

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
}

export type PanelAgentLaunch =
  | {
      ok: true;
      providerId: string;
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
  | { ok: false; code: PanelAgentRunRefusalCode; message: string };

function refuse(code: PanelAgentRunRefusalCode, message: string): PanelAgentLaunch {
  return { ok: false, code, message };
}

export function resolvePanelAgentLaunch(deps: PanelAgentLaunchDeps): PanelAgentLaunch {
  const provider = getActiveProvider(deps.store);
  if (provider.id !== claudeProvider.id) {
    // Чужой CLI с MCP получил бы тот же
    // переходник своим писателем конфига, API-режим — цикл инструментов на
    // сервере. Пока ни того, ни другого нет — честный отказ, а не агент без рук.
    return refuse(
      'provider_unsupported',
      `Агент панели пока работает только с Claude Code, а активный CLI — ${provider.name}. Переключите активный CLI в настройках.`,
    );
  }

  const command = findCliOnPath(providerCliCandidates(provider), deps.detect ?? detectCliOnPath);
  if (command === undefined) {
    return refuse(
      'cli_not_found',
      'Claude Code не найден в PATH процесса панели — агенту нечем работать. Без CLI у агента нет инструментов панели, ключ API здесь не поможет.',
    );
  }

  const settings = deps.store.getSettings();
  const profile = settings.assistantEndpointId
    ? settings.endpointProfiles.find((item) => item.id === settings.assistantEndpointId)
    : undefined;
  // Выбранного профиля больше нет — как у ассистента: облако вендора по умолчанию.
  if (!profile) return { ok: true, providerId: provider.id, command, env: {} };

  if (!profile.ownerPlatformId) {
    return refuse(
      'endpoint_unsupported',
      `Ассистенту панели выбран свой эндпоинт «${profile.name}». Агенту пришлось бы отдать его токен процессу CLI — этого панель не делает. Верните ассистента на провайдера по умолчанию или на контур.`,
    );
  }

  const platformId = profile.ownerPlatformId;
  const platform = readPlatforms(deps.store).find((item) => item.id === platformId);
  const title = platform?.title ?? platformId;
  const port = deps.gatewayPort();
  if (port <= 0) {
    return refuse(
      'contour_unreachable',
      `Агент панели идёт через контур «${title}», а шлюз панели не поднят — ход не запущен, чтобы не уйти в облако вендора. Нажмите «Поднять шлюз» на карточке контура.`,
    );
  }
  // Ключ читается только чтобы ответить «он есть»: в процесс уходит заглушка.
  if (!readToken(deps.appDataDir, platformId)) {
    return refuse(
      'contour_unreachable',
      `Агент панели идёт через контур «${title}», а ключ контура не сохранён — шлюзу нечего подставить. Сохраните ключ на карточке контура.`,
    );
  }

  const vars = claudeProvider.endpointConfig?.anthropic;
  if (!vars) {
    return refuse(
      'provider_unsupported',
      'У Claude Code не описан адрес шлюза — контур не применить.',
    );
  }
  const env: Record<string, string> = {};
  for (const item of buildEndpointPlan(
    targetProfile(profile, platformId, port, 'anthropic'),
    vars,
    PLACEHOLDER_KEY,
    false,
  )) {
    env[item.key] = item.value;
  }
  // Слои у агента сняты всегда (лёгкое окно, `lightWindowLayers`) — строже любой
  // галочки контура, поэтому правила слоёв контура здесь ничего не добавляют.
  const contourPrompt = platform
    ? contourRunPrompt(deps.appDataDir, platform, profile.model).trim()
    : '';
  return {
    ok: true,
    providerId: provider.id,
    command,
    env,
    contourId: platformId,
    ...(contourPrompt ? { contourPrompt } : {}),
  };
}
