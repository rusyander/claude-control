import type { spawn as nodeSpawn } from 'node:child_process';
import { foreignConsumerId } from '@agentdeck/contracts/platform-consumers';
import type { AppStore } from '../lib/app-store.ts';
import type { AgentImage } from '../lib/agent-images.ts';
import {
  localizeText,
  serverText,
  type ServerTextCode,
  type TextLanguage,
  type TextParams,
} from '../lib/server-texts.ts';
import { providerCliCommand } from '../providers/cli.ts';
import { getActiveProvider } from '../providers/registry.ts';
import type { ConfigProvider } from '../providers/types.ts';
import { claudeAsk, lightWindowDir, type HelperAsk, type HelperOutcome } from './assistant.ts';
import { runProviderApi } from './assistant-runner/api.ts';
import { runProviderCli, withImagePaths } from './assistant-runner/cli.ts';
import type { AssistantEndpoint, AssistantRunResult } from './assistant-runner/types.ts';
import { resolveAssistantEndpoint } from './endpoints.ts';
import { contourUnreachable } from './panel-agent/launch.ts';
import type { PlatformRunRoute } from './platform/routing.ts';
import { getRawKey, resolveRunner } from './provider-keys.ts';

/**
 * Чем пойдёт ЛЁГКОЕ ОКНО панели — помощник формы и помощник структуры ресурса.
 * Решение до запуска, без сети и без записи; запуск — `runHelperRoute`.
 *
 * До этого модуля оба помощника брали имя CLI активного провайдера и отдавали
 * ему флаги Claude: Qwen Code получал `--output-format json --tools ""` и
 * отказывал, адрес контура не доезжал вовсе, а профиль «Ассистент панели»,
 * который справка обещает формам, не читался совсем. Порядок решения:
 *
 * 1. Профиль ассистента выбран — ответ по ЕГО адресу прямым вызовом API, для
 *    любого провайдера (так же ходит `/api/assistant/run`). Профиль контура при
 *    погашенном шлюзе или без ключа — отказ: запрос ушёл бы в никуда, а не в
 *    контур. Инструменты окну не нужны, поэтому CLI здесь не нужен тоже.
 * 2. Активен Claude — прежний путь (`runClaudeOneShot`): облако вендора по
 *    подписке. Его ветка не переписывается (незыблемое правило 1).
 * 3. Чужой CLI — ТОТ ЖЕ маршрут, что у его чата (`runRoute('foreign:<cli>')`):
 *    отказ маршрута — отказ окна; CLI на PATH с задокументированным флагом —
 *    запуск с окружением маршрута; нет CLI — ключ API, но только мимо контура:
 *    через контур ключ увёл бы запрос в облако вендора. Ничего из этого нет —
 *    честный отказ с кодом. Claude вместо чужого CLI не подставляется никогда.
 */

export interface HelperRouteDeps {
  store: AppStore;
  appDataDir: string;
  /** Порт живого шлюза; 0 — не поднят. */
  gatewayPort: () => number;
  /** Маршрут прогона по потребителю — `runRoute` сборки сервера. */
  runRoute: (consumer: string) => PlatformRunRoute;
  /** Поиск CLI на PATH (подменяется в тестах). */
  detect?: (command: string) => boolean;
}

/** Отказ окна: русский текст на языке панели плюс код для клиента. */
export interface HelperRefusal {
  error: string;
  messageCode: ServerTextCode;
  params?: TextParams;
}

export type HelperRoute =
  /** Процесс `claude` по подписке — прежний путь окна. */
  | { kind: 'claude'; command: string }
  /** Прямой вызов API по профилю «Ассистент панели». */
  | { kind: 'endpoint'; provider: ConfigProvider; endpoint: AssistantEndpoint }
  /** Чужой CLI неинтерактивным флагом, с окружением маршрута. */
  | {
      kind: 'cli';
      provider: ConfigProvider;
      command: string;
      env: Record<string, string>;
      model?: string;
    }
  /** Чужой провайдер своим ключом API — только мимо контура. */
  | { kind: 'api'; provider: ConfigProvider }
  | { kind: 'refused'; refusal: HelperRefusal };

function languageOf(store: AppStore): TextLanguage {
  return store.getSettings().language === 'en' ? 'en' : 'ru';
}

function refused(store: AppStore, code: ServerTextCode, params?: TextParams): HelperRoute {
  return {
    kind: 'refused',
    refusal: {
      error: localizeText(serverText(code, params), languageOf(store)),
      messageCode: code,
      ...(params ? { params } : {}),
    },
  };
}

export function resolveHelperRoute(deps: HelperRouteDeps): HelperRoute {
  const provider = getActiveProvider(deps.store);
  const settings = deps.store.getSettings();
  const profile = settings.assistantEndpointId
    ? (settings.endpointProfiles ?? []).find((item) => item.id === settings.assistantEndpointId)
    : undefined;

  if (profile) {
    if (profile.ownerPlatformId) {
      const down = contourUnreachable(deps, profile.ownerPlatformId);
      if (down) {
        return refused(
          deps.store,
          down.cause === 'gateway_down'
            ? 'assistant-contour-gateway-down'
            : 'assistant-contour-no-token',
          { title: down.title },
        );
      }
    }
    const endpoint = resolveAssistantEndpoint(deps.store, deps.appDataDir);
    if (endpoint) return { kind: 'endpoint', provider, endpoint };
  }

  if (provider.id === 'claude') return { kind: 'claude', command: providerCliCommand(provider) };

  // Тот же потребитель, что у чата этого CLI: галочка «Qwen Code» на контуре
  // значит «этот CLI через контур» — и в окне панели тоже.
  const route = deps.runRoute(foreignConsumerId(provider.id));
  if (route.refusal)
    return refused(deps.store, 'assistant-route-refused', { reason: route.refusal });
  const routed = Object.keys(route.env).length > 0;

  const scriptable = Boolean(provider.assistant?.oneShotArgs);
  const runner = resolveRunner(provider, deps.appDataDir, deps.detect);
  if (runner.mode === 'cli' && scriptable && runner.cliCommandFound) {
    return {
      kind: 'cli',
      provider,
      command: runner.cliCommandFound,
      // Набор панели — как у чата этого CLI (`QWEN_HOME` в режиме «Наши»):
      // окно и чат одного CLI не должны ходить разными домашними каталогами.
      env: { ...route.env, ...route.kit?.env },
      ...(route.model?.model ? { model: route.model.model } : {}),
    };
  }
  const names = { provider: provider.name };
  if (routed) return refused(deps.store, 'assistant-contour-cli-missing', names);
  const api = provider.assistant?.apiKind;
  if (api && api !== 'none' && getRawKey(provider, deps.appDataDir)) {
    return { kind: 'api', provider };
  }
  if (!scriptable && (!api || api === 'none')) {
    return refused(deps.store, 'assistant-provider-unsupported', names);
  }
  return refused(deps.store, 'assistant-provider-unavailable', names);
}

export interface HelperRunOptions {
  appDataDir: string;
  timeoutMs: number;
  /** Пустая временная папка окна — рабочий каталог чужого CLI. */
  cwd: string;
  spawnImpl?: typeof nodeSpawn;
}

function outcomeOf(result: AssistantRunResult): HelperOutcome {
  return result.ok
    ? { ok: true, text: result.reply }
    : { ok: false, error: result.error ?? result.reason };
}

/**
 * Запуск по уже решённому маршруту — для всего, КРОМЕ `claude` (его ведёт
 * `runClaudeOneShot`, тот возвращает конверт JSON и читает картинки потоком).
 * Промпт уже под маской: секреты сняли вызывающие.
 */
export async function runHelperRoute(
  route: Exclude<HelperRoute, { kind: 'claude' }>,
  prompt: string,
  images: readonly AgentImage[],
  options: HelperRunOptions,
): Promise<HelperOutcome> {
  if (route.kind === 'refused') return { ok: false, ...route.refusal };
  const message = { role: 'user' as const, content: prompt, images };
  const base = {
    appDataDir: options.appDataDir,
    timeoutMs: options.timeoutMs,
    ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
  };

  if (route.kind === 'cli') {
    // Картинки чужому CLI — файлами в рабочей папке и путями в тексте: входа для
    // картинки в запросе у них нет, а читать вне рабочей области Qwen и Gemini не
    // станут.
    const [withPaths] = images.length > 0 ? withImagePaths([message], options.cwd) : [message];
    return outcomeOf(
      await runProviderCli(
        route.provider,
        withPaths!.content,
        { ...base, env: route.env, ...(route.model ? { model: route.model } : {}) },
        route.command,
        options.cwd,
      ),
    );
  }

  // У прямого вызова нет своего таймаута — окно не должно висеть дольше CLI.
  const signal = AbortSignal.timeout(options.timeoutMs);
  if (route.kind === 'endpoint') {
    return outcomeOf(
      await runProviderApi(route.provider, [message], '', {
        ...base,
        signal,
        endpoint: route.endpoint,
      }),
    );
  }
  const key = getRawKey(route.provider, options.appDataDir) ?? '';
  return outcomeOf(await runProviderApi(route.provider, [message], key, { ...base, signal }));
}

/**
 * Маршрут → функция ответа окну (`askAssistant`, `assistStructure`). Чужой CLI
 * работает в пустой временной папке, как и `claude` лёгкого окна: каталог
 * сервера принёс бы правила репозитория.
 */
export function helperAsk(
  route: HelperRoute,
  options: { appDataDir: string; spawnImpl?: typeof nodeSpawn },
): HelperAsk {
  if (route.kind === 'claude') return claudeAsk(route.command, options.spawnImpl);
  return async (prompt, images, timeoutMs) => {
    const { dir, cleanup } = lightWindowDir();
    try {
      return await runHelperRoute(route, prompt, images, {
        appDataDir: options.appDataDir,
        timeoutMs,
        cwd: dir,
        ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
      });
    } finally {
      cleanup();
    }
  };
}

/**
 * Что маршрутам окна даёт сборка сервера: маршрут прогона и порт шлюза. Поиск
 * CLI и запуск процесса подменяются только проверками.
 */
export interface HelperRouteWiring {
  runRoute: (consumer: string) => PlatformRunRoute;
  gatewayPort: () => number;
  detect?: (command: string) => boolean;
  spawnImpl?: typeof nodeSpawn;
}

/** Решение на ЭТОТ запрос → функция ответа: галочка, снятая минуту назад, уже действует. */
export function helperAskFor(
  store: AppStore,
  appDataDir: string,
  wiring: HelperRouteWiring,
): HelperAsk {
  const route = resolveHelperRoute({
    store,
    appDataDir,
    gatewayPort: wiring.gatewayPort,
    runRoute: wiring.runRoute,
    ...(wiring.detect ? { detect: wiring.detect } : {}),
  });
  return helperAsk(route, {
    appDataDir,
    ...(wiring.spawnImpl ? { spawnImpl: wiring.spawnImpl } : {}),
  });
}
