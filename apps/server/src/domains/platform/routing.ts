import type {
  Platform,
  PlatformConsumerOption,
  PlatformConsumerReason,
} from '@agentdeck/contracts';
import {
  foreignConsumerId,
  foreignProviderId,
  platformRunConsumers,
  PLATFORM_ASSISTANT_CONSUMER,
  PLATFORM_TERMINAL_CONSUMER,
} from '@agentdeck/contracts/platform-consumers';
import type { AppStore } from '../../lib/app-store.ts';
import { isKnownProviderId, getProvider, listProviders } from '../../providers/registry.ts';
import type { ConfigProvider } from '../../providers/types.ts';
import { buildEndpointPlan } from '../endpoints/endpoint-plan.ts';
import { promptText } from '../prompts.ts';
import {
  activeGatewaySettings,
  buildManagedProfile,
  managedModel,
  PLACEHOLDER_KEY,
} from './apply/profile.ts';
import { pickApiKind, targetProfile } from './apply/targets.ts';
import { consumersOf, readPlatforms, readToken } from './store.ts';

/**
 * Маршрут в момент ЗАПУСКА: кто из прогонов идёт через контур и с каким
 * окружением.
 *
 * ПОЧЕМУ ОКРУЖЕНИЕ, А НЕ ФАЙЛ. Запись адреса в `~/.claude/settings.json` —
 * один маршрут на всё: её получает и чат, и агент тестов, и запуск, сделанный
 * человеком в терминале мимо панели. Переменные процесса достаются ровно
 * одному прогону, поэтому «чат через контур, тесты своим ключом» — это выбор,
 * а не мечта. Файл остаётся ОТДЕЛЬНЫМ потребителем (`terminal`), и его
 * галочка снята по умолчанию.
 *
 * ПОЧЕМУ ПЛАН СОБИРАЕТСЯ ТЕМ ЖЕ ПОСТРОИТЕЛЕМ, ЧТО И ЗАПИСЬ В ФАЙЛ. Имена
 * переменных берутся из реестра провайдеров, значения — из `buildEndpointPlan`,
 * то есть из кода, которым контур уже применяется к файлам. Второй сборщик
 * окружения разошёлся бы с первым на первой же правке реестра, и разошёлся бы
 * молча: CLI с адресом, но без имени переменной модели просто ушёл бы в облако
 * вендора.
 *
 * ЗДЕСЬ НЕТ НИ СЕТИ, НИ ЗАПИСИ. Решение принимается по состоянию панели, и
 * принимается на КАЖДЫЙ запуск: снятая галочка действует со следующего
 * прогона, идущие не трогаются (остановить чужой процесс ради настройки —
 * последнее, чего человек ждёт от галочки).
 */

export interface PlatformRoutingDeps {
  store: AppStore;
  appDataDir: string;
  /**
   * Порт ЖИВОГО слушателя; 0 — шлюз не поднят. Функцией по той же причине, что
   * и в активации: записанный в состоянии порт — след прошлого запуска.
   */
  gatewayPort: () => number;
}

/** Почему прогон пошёл провайдером по умолчанию. */
export type PlatformRouteSkipReason =
  /** Активного контура нет вовсе. */
  | 'no_active_platform'
  /** Контур есть, но этот потребитель не отмечен. */
  | 'consumer_off'
  /** Шлюз не поднят: адрес существовал бы, но отказал бы соединением. */
  | 'gateway_down'
  /** Ключ контура не сохранён — шлюзу нечего подставить. */
  | 'no_token'
  /** Потребитель ходит не процессом: ассистент — профилем, терминал — файлами. */
  | 'not_a_run'
  | PlatformConsumerReason;

export type PlatformRouteDecision =
  | ({ routed: true; platformId: string } & PlatformRunRoute)
  | { routed: false; reason: PlatformRouteSkipReason };

/** Что прогон получает от контура: окружение и — если включён — свой промпт. */
export interface PlatformRunRoute {
  /** Переменные окружения ОДНОГО процесса; ключа контура среди них нет. */
  env: Record<string, string>;
  /**
   * Системный промпт из каталога ВМЕСТО промпта CLI (Т5.4а, переключатель
   * «Свой промпт контура» на контуре, включён по умолчанию).
   *
   * Причина замера, а не вкуса: H1 (§2.3) прогнала 14B с полным системным
   * промптом Claude Code и с коротким. С полным модель отвечала «Файл создан.»
   * и не вызывала ничего; с коротким — делала настоящий вызов с первой попытки.
   * 97 тыс. символов инструкций, написанных под Claude, топят модель среднего
   * класса, а через контур ходят именно такие.
   */
  systemPrompt?: string;
}

/** Активный контур либо undefined. Читается на каждый запуск: он же и меняется. */
export function activePlatform(store: AppStore): Platform | undefined {
  const id = store.getSettings().activePlatformId;
  if (!id) return undefined;
  return readPlatforms(store).find((platform) => platform.id === id);
}

/**
 * Провайдер, чей CLI поднимает этот потребитель. Прогоны панели ведёт Claude
 * (реестр прогонов и агент тестов — его), чужой чат назван в самом
 * потребителе.
 */
function providerOf(consumer: string): ConfigProvider | undefined {
  const foreign = foreignProviderId(consumer);
  if (foreign) return isKnownProviderId(foreign) ? getProvider(foreign) : undefined;
  return (platformRunConsumers as readonly string[]).includes(consumer)
    ? getProvider('claude')
    : undefined;
}

/**
 * Решение по одному запуску. Зовётся из мест спавна — реестра прогонов, агента
 * тестов, чата чужого CLI, — и ни одно из них не знает про контуры ничего,
 * кроме этой функции.
 */
export function resolveRunRoute(
  deps: PlatformRoutingDeps,
  consumer: string,
): PlatformRouteDecision {
  const provider = providerOf(consumer);
  if (!provider) return { routed: false, reason: 'not_a_run' };

  const platform = activePlatform(deps.store);
  if (!platform) return { routed: false, reason: 'no_active_platform' };
  if (!consumersOf(platform).includes(consumer)) return { routed: false, reason: 'consumer_off' };

  const unsupported = routeReason(provider);
  if (unsupported) return { routed: false, reason: unsupported };

  const port = deps.gatewayPort();
  if (port <= 0) return { routed: false, reason: 'gateway_down' };
  // Ключ читается ТОЛЬКО чтобы ответить «он есть»: в окружение прогона уходит
  // заглушка, а настоящий ключ подставляет шлюз — в этом весь смысл шлюза.
  if (!readToken(deps.appDataDir, platform.id)) return { routed: false, reason: 'no_token' };

  const apiKind = pickApiKind(provider);
  const vars = apiKind ? provider.endpointConfig?.[apiKind] : undefined;
  if (!apiKind || !vars) return { routed: false, reason: 'no_env_section' };

  // Те же два вызова, которыми контур применяется к файлам: управляемый профиль
  // и его пересборка под диалект этого CLI. Один сборщик на оба пути — значит
  // окружение прогона и запись в файл не разойдутся ни в имени переменной, ни
  // в адресе.
  const managed = buildManagedProfile(
    platform,
    { ...activeGatewaySettings(deps.store), port },
    managedModel(deps.store, platform.id),
  );
  const profile = targetProfile(managed, platform.id, port, apiKind);

  const env: Record<string, string> = {};
  for (const item of buildEndpointPlan(profile, vars, PLACEHOLDER_KEY, false)) {
    env[item.key] = item.value;
  }
  // Промпт берётся из каталога (Т4), а не строкой здесь: человек правит его в
  // панели, и вторая копия в коде означала бы, что половина прогонов слушает
  // правку, а половина — нет.
  const systemPrompt = platform.contourPrompt ? promptText(deps.appDataDir, 'contour-agent') : '';
  return {
    routed: true,
    platformId: platform.id,
    env,
    ...(systemPrompt.trim() ? { systemPrompt } : {}),
  };
}

/**
 * Почему через окружение этот CLI в контур не пойдёт — теми же словами, что и
 * у целей применения, плюс `file_only`.
 *
 * `file_only` — не придирка: адрес codex и continue живёт в их конфигурационном
 * файле, файл один на машину, и «включить только для чата» там физически не
 * получается. Панель говорит «только глобально» и оставляет человеку терминал.
 */
function routeReason(provider: ConfigProvider): PlatformConsumerReason | undefined {
  if (pickApiKind(provider)) return undefined;
  if (provider.endpointFile) return 'file_only';
  if (provider.endpointConfig) return 'gateway_dialect';
  return provider.capabilities.env === 'ready' ? 'no_documented_base_url' : 'no_env_section';
}

/**
 * Список «Где работает контур» — то, что рисует мастер. Собирается из реестра
 * провайдеров и из того, что панель ДЕЙСТВИТЕЛЬНО запускает: чужой CLI без
 * своего чата в список не попадает вовсе, а не стоит там мёртвой галочкой.
 */
export function listConsumerOptions(platform: Platform): PlatformConsumerOption[] {
  const selected = new Set(consumersOf(platform));
  // Имя встроенного потребителя не приезжает с сервера: «Чат» и «Терминал»
  // читает человек, а язык знает только клиент.
  const options: PlatformConsumerOption[] = [
    ...platformRunConsumers.map((id) => ({
      id,
      title: '',
      selected: selected.has(id),
      scope: 'run' as const,
    })),
    {
      id: PLATFORM_ASSISTANT_CONSUMER,
      title: '',
      selected: selected.has(PLATFORM_ASSISTANT_CONSUMER),
      scope: 'profile',
    },
  ];

  for (const provider of listProviders()) {
    // В списке только те, у кого чат В ПАНЕЛИ действительно есть: чат чужого
    // CLI поднимается неинтерактивным флагом (`oneShotArgs`), и провайдер без
    // него стоял бы галочкой, за которой не запускается ничего.
    if (provider.id === 'claude' || !provider.assistant?.oneShotArgs) continue;
    const id = foreignConsumerId(provider.id);
    const reason = routeReason(provider);
    options.push({
      id,
      title: provider.name,
      // Недоступный потребитель не бывает отмеченным: галочка, которую нельзя
      // исполнить, — обещание, которого панель не держит.
      selected: selected.has(id) && !reason,
      scope: 'run',
      ...(reason ? { reason } : {}),
    });
  }

  options.push({
    id: PLATFORM_TERMINAL_CONSUMER,
    title: '',
    selected: selected.has(PLATFORM_TERMINAL_CONSUMER),
    scope: 'files',
  });

  return options;
}
