import type {
  Platform,
  PlatformConsumerOption,
  PlatformConsumerReason,
  PlatformModelChoice,
  PlatformRunPlan,
} from '@agentdeck/contracts';
import { chooseRunModel } from '@agentdeck/contracts/platform-models';
import {
  foreignConsumerId,
  foreignProviderId,
  platformRunConsumers,
  PLATFORM_ASSISTANT_CONSUMER,
  PLATFORM_TERMINAL_CONSUMER,
} from '@agentdeck/contracts/platform-consumers';
import type { AppStore } from '../../lib/app-store.ts';
import {
  localizeText,
  serverText,
  type ServerTextCode,
  type TextLanguage,
} from '../../lib/server-texts.ts';
import { isKnownProviderId, getProvider, listProviders } from '../../providers/registry.ts';
import type { ConfigProvider } from '../../providers/types.ts';
import { buildEndpointPlan } from '../endpoints/endpoint-plan.ts';
import { promptText } from '../prompts.ts';
import { activeGatewaySettings, buildManagedProfile, PLACEHOLDER_KEY } from './apply/profile.ts';
import { pickApiKind, targetProfile } from './apply/targets.ts';
import { runLayers, type RunLayers } from './layers.ts';
import { effortAccepted, modelRulesFor, toolRouteOf } from './models.ts';
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
  /**
   * Прогон чужого CLI, которого нет в реестре провайдеров (`foreign:<cli>` из
   * устаревшего архива или снятого провайдера). Отдельным словом от `not_a_run`:
   * тот ответ значит «так задумано», а этот — «сохранено то, чего панель не знает».
   *
   * Подписи на экране у этого слова нет намеренно, и это не забытый перевод:
   * чат снятого провайдера не рисуется вовсе (шапке нужен сам провайдер), так
   * что читает диагноз только тот, кто спросил план маршрутом, — агент панели
   * и проверки. Шапки же различают ровно то, что человек может исправить:
   * `gateway_down` и `no_token`.
   */
  | 'unknown_provider'
  | PlatformConsumerReason;

export type PlatformRouteDecision =
  | ({ routed: true; platformId: string } & PlatformRunRoute)
  | { routed: false; reason: PlatformRouteSkipReason; refusal?: string };

/** Что прогон получает от контура: окружение и — если включён — свой промпт. */
export interface PlatformRunRoute {
  /** Переменные окружения ОДНОГО процесса; ключа контура среди них нет. */
  env: Record<string, string>;
  /**
   * Прогон НЕ запускается вовсе, и это текст отказа для человека.
   *
   * Обязательный контур с отмеченной галочкой, у которого нет шлюза или ключа:
   * пустое окружение здесь значило бы прогон мимо контура, то есть молча в
   * облако вендора (живой прогон 14.09.2026 — чат ушёл бы туда при погашенном
   * шлюзе). Место спавна обязано отказать этим текстом, а не запускать.
   */
  refusal?: string;
  /**
   * Модель, которой пойдёт прогон, и откуда она взялась (Т6).
   *
   * Считается ЗДЕСЬ, а не остаётся на усмотрение CLI, по одной причине: прогон
   * со своим выбором уходит с `--model`, и этот флаг перебивает адресную
   * переменную окружения. До контура доезжало имя вендора («sonnet»), которого
   * он не знает, — 403 «модель» на каждом сообщении, невидимый ровно до тех
   * пор, пока имена в панели и в контуре случайно совпадают.
   */
  model?: PlatformModelChoice;
  /**
   * Контур принимает усилие рассуждения. `false` — прогон уходит БЕЗ `--effort`
   * (решение владельца 12.09.2026): контур его не примет, а человек заплатит
   * за глубину, которой не будет. Отсутствие поля — «не через контур», и тогда
   * усилие остаётся тем, что выбрал человек.
   */
  effort?: boolean;
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
  /**
   * Наши слои в этом прогоне (Т8): флаги запуска и судьба нашей дописки к
   * системному промпту.
   *
   * Только для прогонов CLI Claude: `--setting-sources`, `--disable-slash-commands`
   * и `--strict-mcp-config` — его флаги, и чужой CLI получил бы с ними отказ
   * запуска вместо прогона. У чужих CLI свои слои и свои файлы, и панель их не
   * трогает — на карточке это сказано словами.
   */
  layers?: RunLayers;
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
 *
 * Правило «чат в панели действительно есть» здесь то же, что в каталоге
 * (`listConsumerOptions`): чужой CLI без `oneShotArgs` панель не запускает, и
 * галочки за ним в списке нет — значит, и маршрут ему не собирается. Иначе
 * сохранённый мимо мастера `foreign:<cli>` получил бы полное окружение контура
 * в тот день, когда провайдеру допишут секцию переменных.
 */
function providerOf(consumer: string): ConfigProvider | undefined {
  const foreign = foreignProviderId(consumer);
  if (foreign) {
    if (!isKnownProviderId(foreign)) return undefined;
    const provider = getProvider(foreign);
    return provider?.assistant?.oneShotArgs ? provider : undefined;
  }
  return (platformRunConsumers as readonly string[]).includes(consumer)
    ? getProvider('claude')
    : undefined;
}

/**
 * Системный промпт прогона через контур: как работать (агент), затем чем контур
 * отличается от прямого запроса (преамбула). Один текст, а не два флага: у CLI
 * одно место для своего промпта, и `--system-prompt-file` принимает его целиком.
 * Правка, стёртая человеком до пустоты, снимает свою часть, а не весь промпт.
 */
function contourSystemPrompt(appData: string, identity: string): string {
  return [
    ...(['contour-agent', 'contour-preamble'] as const).map((id) => promptText(appData, id)),
    identity,
  ]
    .map((text) => text.trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Кто отвечает на самом деле. Строкой здесь, а не в каталоге промптов: это не
 * стиль, который человек правит, а факт маршрута — имя модели и контура
 * известны только в момент запуска. Без неё модель контура собирает себя из
 * окружения, а там всё говорит «Claude»: личный CLAUDE.md, память, имена
 * инструментов. Живой прогон 14.09.2026: Qwen3.8 через dev-стенд платформы компании на
 * вопрос «что ты за модель» назвалась Claude Opus 5, хотя транскрипт записал
 * ответ от `Qwen/Qwen3.8-27B-FP8`.
 */
export function contourIdentity(title: string, model: string): string {
  const who = model ? `модель ${model}` : 'модель, назначенная контуром';
  return (
    `В этом разговоре отвечаешь ты — ${who}, запросы идут через контур «${title}». ` +
    'На вопрос, какая ты модель, называй именно её. Ты не Claude и не модель Anthropic, ' +
    'даже если окружение (CLAUDE.md, память, названия инструментов) говорит о Claude: ' +
    'Claude Code здесь только программа-агент, в которой ты работаешь.'
  );
}

/**
 * Системный промпт хода через контур: пусто, когда промпт контура выключен. Одна
 * функция на прогоны реестра и ход агента панели — вторая сборка разошлась бы
 * с первой на первой правке каталога.
 */
export function contourRunPrompt(appData: string, platform: Platform, model: string): string {
  return platform.contourPrompt
    ? contourSystemPrompt(appData, contourIdentity(platform.title, model))
    : '';
}

/**
 * Причина и починка — одним текстом на причину (без ключа поднимать шлюз
 * бесполезно): две половины одной фразы при переводе разошлись бы. Отказ уезжает
 * человеку СТРОКОЙ (`new Error(refusal)` в реестре прогонов), кода рядом с ней
 * нет — поэтому язык панели применяется здесь же.
 */
const unreachableCode = (reason: 'gateway_down' | 'no_token'): ServerTextCode =>
  reason === 'gateway_down' ? 'contour-required-gateway-down' : 'contour-required-no-token';

/**
 * Галочка стоит, а дойти до контура нечем. Только эти две причины: остальные
 * отказы (`file_only` и прочие) значат «этот CLI в контур окружением не ходит»,
 * и у `file_only` адрес может жить в файле — отказ сломал бы рабочий маршрут.
 * «По возможности» оставляет прежний проход мимо контура.
 */
function unreachable(
  platform: Platform,
  reason: 'gateway_down' | 'no_token',
  language: TextLanguage,
): PlatformRouteDecision {
  if (platform.mode === 'best-effort') return { routed: false, reason };
  return {
    routed: false,
    reason,
    refusal: localizeText(serverText(unreachableCode(reason), { title: platform.title }), language),
  };
}

/**
 * Решение по одному запуску. Зовётся из мест спавна — реестра прогонов, агента
 * тестов, чата чужого CLI, — и ни одно из них не знает про контуры ничего,
 * кроме этой функции.
 */
export function resolveRunRoute(
  deps: PlatformRoutingDeps,
  consumer: string,
  /** Модель, которую назвал сам прогон (шапка чата, каскад, «модель на группу»). */
  asked = '',
  /**
   * Метка прогона для адреса шлюза. Её просит чат чужого CLI: транскрипта у него
   * нет, и узнать, что контур сжимал историю именно в ЭТОМ прогоне, можно только
   * по метке, с которой пришёл запрос. Прогоны Claude её не берут — их ответ
   * находится по id сообщения в транскрипте, а адрес остаётся прежним.
   */
  runTag = '',
): PlatformRouteDecision {
  const provider = providerOf(consumer);
  const platform = activePlatform(deps.store);
  // Порядок: сначала «контура нет вовсе», и только потом диагноз про самого
  // потребителя. Иначе панель без единого контура отвечала бы про устаревший
  // `foreign:<cli>` словом, которое к её состоянию отношения не имеет.
  if (!platform) return { routed: false, reason: 'no_active_platform' };
  const foreign = foreignProviderId(consumer);
  if (foreign && !isKnownProviderId(foreign)) return { routed: false, reason: 'unknown_provider' };
  if (!provider) return { routed: false, reason: 'not_a_run' };
  if (!consumersOf(platform).includes(consumer)) return { routed: false, reason: 'consumer_off' };

  const unsupported = routeReason(provider);
  if (unsupported) return { routed: false, reason: unsupported };

  const port = deps.gatewayPort();
  if (port <= 0) return unreachable(platform, 'gateway_down', deps.store.getSettings().language);
  // Ключ читается ТОЛЬКО чтобы ответить «он есть»: в окружение прогона уходит
  // заглушка, а настоящий ключ подставляет шлюз — в этом весь смысл шлюза.
  if (!readToken(deps.appDataDir, platform.id)) {
    return unreachable(platform, 'no_token', deps.store.getSettings().language);
  }

  const apiKind = pickApiKind(provider);
  const vars = apiKind ? provider.endpointConfig?.[apiKind] : undefined;
  if (!apiKind || !vars) return { routed: false, reason: 'no_env_section' };

  // Те же два вызова, которыми контур применяется к файлам: управляемый профиль
  // и его пересборка под диалект этого CLI. Один сборщик на оба пути — значит
  // окружение прогона и запись в файл не разойдутся ни в имени переменной, ни
  // в адресе.
  //
  // Модель берётся ПОД ЭТОГО потребителя и с учётом того, что назвал прогон:
  // управляемый профиль знает только общую по умолчанию, а «чат моделью
  // покрупнее, тесты подешевле» — это выбор на потребителя (Т6).
  const model = chooseRunModel(modelRulesFor(deps.store, platform, consumer), asked);
  const managed = buildManagedProfile(
    platform,
    { ...activeGatewaySettings(deps.store), port },
    model.model,
  );
  const profile = targetProfile(managed, platform.id, port, apiKind, runTag);

  const env: Record<string, string> = {};
  for (const item of buildEndpointPlan(profile, vars, PLACEHOLDER_KEY, false)) {
    env[item.key] = item.value;
  }
  // Промпт берётся из каталога (Т4), а не строкой здесь: человек правит его в
  // панели, и вторая копия в коде означала бы, что половина прогонов слушает
  // правку, а половина — нет. Преамбула контура едет следом: до аудита MD-06 её
  // можно было править, а не читал её никто.
  const systemPrompt = contourRunPrompt(deps.appDataDir, platform, model.model);
  return {
    routed: true,
    platformId: platform.id,
    env,
    model,
    // compromise: no-effort — драйвер не объявил приём усилия, и прогон уходит без `--effort`
    effort: effortAccepted(platform),
    ...(systemPrompt.trim() ? { systemPrompt } : {}),
    // Наши слои (Т8) — только у Claude: флаги снятия слоёв его, и чужому CLI
    // они бы стоили не прогона без правил, а отказа запуска. Считаются на
    // КАЖДОМ старте по той же причине, что и остальной маршрут: снятая галочка
    // должна действовать со следующего прогона, а не с перезапуска панели.
    // compromise: rules-partial — личные правила, хуки и права снимаются одним флагом, порознь CLI их не различает
    ...(provider.id === 'claude' ? { layers: runLayers(platform) } : {}),
  };
}

/**
 * Решение маршрута → то, что получает МЕСТО СПАВНА: окружение, модель, усилие,
 * промпт и снятые слои.
 *
 * Отдельной функцией, а не замыканием в сборке сервера (`bootstrap/runtime.ts`),
 * потому что ревью Т13 нашло здесь дыру проверки: проекцию исполнял только
 * живой запуск панели, и удаление строки `layers` или `model` оставляло гейт
 * зелёным — прогон молча уходил бы со всеми нашими слоями и с именем вендора,
 * которого контур не знает.
 *
 * Пустой маршрут ОБЯЗАН затирать прежний: продолжение остановленного прогона
 * приходит со старыми параметрами, и адрес контура пережил бы снятую галочку.
 * Модели и усилия в таком ответе нет вовсе — выбор человека остаётся его
 * выбором.
 */
export function runRouteOf(decision: PlatformRouteDecision): PlatformRunRoute {
  if (!decision.routed) {
    return decision.refusal ? { env: {}, refusal: decision.refusal } : { env: {} };
  }
  return {
    env: decision.env,
    model: decision.model,
    effort: decision.effort,
    ...(decision.systemPrompt ? { systemPrompt: decision.systemPrompt } : {}),
    ...(decision.layers ? { layers: decision.layers } : {}),
  };
}

/**
 * Чем пойдёт прогон этого потребителя, если запустить его сейчас, — ответ для
 * шапки чата (Т6).
 *
 * Тем же решением, что и сам запуск: второй расчёт «покажем, что собирались бы
 * сделать» разошёлся бы с первым на первой же правке и врал бы человеку ровно
 * там, где он смотрит перед отправкой сообщения. Правила отдаются целиком —
 * клиент пересчитывает выбор на каждое переключение модели сам.
 */
export function describeRunPlan(deps: PlatformRoutingDeps, consumer: string): PlatformRunPlan {
  const decision = resolveRunRoute(deps, consumer);
  const platform = activePlatform(deps.store);
  if (!decision.routed || !platform) {
    return {
      routed: false,
      title: platform?.title ?? '',
      ...(decision.routed ? {} : { reason: decision.reason }),
      ...(!decision.routed && decision.refusal ? { refused: true as const } : {}),
      ...(bypassed(decision) ? { bypassed: true as const } : {}),
      rules: { model: '', source: 'none', map: {}, catalog: [] },
      effort: true,
    };
  }
  return {
    routed: true,
    title: platform.title,
    rules: modelRulesFor(deps.store, platform, consumer),
    effort: effortAccepted(platform),
    // Путь инструментов — чтобы чат назвал вызов, написанный текстом при
    // выключенной прослойке, а не показал его немым JSON (развилка 3).
    toolRoute: toolRouteOf(platform),
    // Слои — из того же решения, что и запуск: шапка показывает снятые ДО
    // отправки, а не объясняет их постфактум. У чужого CLI поля нет вовсе, и
    // шапка про наши слои молчит — их там и не снимают.
    ...(decision.layers ? { layers: decision.layers } : {}),
  };
}

/**
 * Галочка стоит, а прогон пойдёт мимо контура в облако вендора — «по
 * возможности» без шлюза или ключа. Решение по контуру №4: режим остаётся,
 * только пока каждый такой уход назван в шапке чата прямо. Обязательный контур
 * здесь не уходит, а отказывает (`refusal`), и подпись у него своя.
 */
function bypassed(decision: PlatformRouteDecision): boolean {
  if (decision.routed || decision.refusal) return false;
  return decision.reason === 'gateway_down' || decision.reason === 'no_token';
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
