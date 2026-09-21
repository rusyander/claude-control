import type {
  EnvItem,
  EnvNeed,
  EnvNeeds,
  EnvTrigger,
  HookItem,
  PermissionDecision,
  PermissionItem,
  PluginForm,
  PluginItem,
  SkillItem,
} from '@agentdeck/contracts/portable-env';
import { envNeeds, permissionDecisions } from '@agentdeck/contracts/portable-env';
import type {
  FidelityCondition,
  FidelityLevel,
  FidelityReason,
  FidelityVerdict,
} from '@agentdeck/contracts/portable-fidelity';
import { worstFidelity } from '@agentdeck/contracts/portable-fidelity';
import type { ConfigProvider } from '../../providers/types.ts';
import type { SectionTargets } from './project.ts';
import { providerHookEvents } from './hook-events.ts';
import { triggerOfEvent } from './needs.ts';
import { isModeRule } from './permissions-map.ts';

/**
 * МАТРИЦА ВЕРНОСТИ (П1.1): на каком уровне запись канона доедет до конкретного
 * CLI и почему.
 *
 * Чистая функция и ни одного обращения к диску. Вход — запись канона и ЗАПИСЬ
 * ЦЕЛИ В КАТАЛОГЕ; выход — уровень, причина из закрытого словаря и условие, при
 * котором уровень держится.
 *
 * ГЛАВНОЕ ПРАВИЛО МОДУЛЯ: здесь нет и не может появиться таблицы «провайдер →
 * уровень». Ни одной ветки `if (provider === '<id>')`, ни одного списка id.
 * Различие провайдеров выражено каталогом: есть ли у цели механизм
 * (`skillsConfig`, `hooksConfig`, `permissionsConfig`, …), какие события её
 * механизм отдаёт и какие из них умеют блокировать, умеет ли панель запускать
 * этот CLI (`assistant.cliRunnable`) и есть ли у него задокументированный адрес
 * эндпоинта (`endpointConfig`/`endpointFile`) — без последнего провод поставить
 * не во что. Одиннадцатый CLI получает полный столбец матрицы, не изменив ни
 * одного файла здесь; тест на выдуманного провайдера это и проверяет.
 *
 * ТРИ ПРАВИЛА ЧЕСТНОСТИ, из которых всё остальное — следствия:
 *
 *  1. **Уровень считается по ХУДШЕМУ из требований записи** (§2 плана). Хук,
 *     которому нужны `tool_name` и `tool_input`, на CLI без событий инструментов
 *     нативно работать не может — это следует из `needs`, а не из мнения.
 *  2. **Понижение только в сторону строгости** (инвариант 6). Блокирующая
 *     запись, попавшая на событие, которое блокировать не умеет, НЕ становится
 *     молча наблюдательной: уровень падает, а причина называется (`blocking_lost`).
 *  3. **`undetermined` считается требующим ВСЕГО.** Невыведенные требования —
 *     это не «ничего не нужно»: запись получает худший возможный уровень и
 *     решение человека.
 */

/** Условия — вынесены в константы: их читает и приговор, и его пояснение. */
const THROUGH_PANEL: FidelityCondition = 'run_through_panel';
const THROUGH_WIRE: FidelityCondition = 'enable_contour';

/**
 * Что цель умеет — выжимка из её записи в каталоге. Отдельный тип, потому что
 * уровень считается ПО ФАКТАМ ЦЕЛИ, а не по её имени: подменив факт в профиле,
 * тест обязан увидеть другую матрицу (самопроверка П1.1).
 */
export interface TargetProfile {
  readonly provider: string;
  /** Есть ли у цели раздел инструкций (файл, список ссылок или каталог правил). */
  readonly instructions: boolean;
  /** Каталог скиллов цели; `shared` — каталоги, которые цель читает ПОМИМО своего. */
  readonly skills: { readonly own: boolean; readonly shared: readonly string[] };
  readonly commands: boolean;
  readonly subagents: boolean;
  /** События механизма хуков в терминах канона плюс способность блокировать. */
  readonly hookEvents: readonly { readonly trigger: EnvTrigger; readonly blocking: boolean }[];
  /** Права: правилами, режимом или никак; и какие решения формат принимает. */
  readonly permissions: {
    readonly model: 'rules' | 'mode' | 'none';
    readonly decisions: readonly ('allow' | 'ask' | 'deny')[];
  };
  readonly mcp: boolean;
  readonly env: boolean;
  /**
   * Какие ФОРМЫ плагина цель принимает как единицу — не «есть ли раздел».
   *
   * Список, а не флаг, потому что механизмов плагина в природе несколько, и
   * принявший один не принимает другой: файл кода `opencode` для Claude не
   * плагин, а просто файл. Формы выведены из задокументированных путей каталога
   * (каталог файлов → `module`, список пакетов в конфиге → `package`), поэтому
   * ветки по идентификатору CLI здесь нет.
   *
   * `installed` не входит сюда НИКОГДА: единицу чужого магазина панель не
   * устанавливает — это прямо вне объёма партии.
   */
  readonly pluginForms: readonly PluginForm[];
  /**
   * Плагины у цели ЕСТЬ, но единицы попадают в них УСТАНОВКОЙ — из магазина или
   * реестра (так устроен сам Claude). Отдельный факт от «форм не принимает
   * вовсе»: сказать такой цели «механизма нет» неверно — раздел плагинов у неё
   * есть и человек его видит, — а установка плагинов прямо вне объёма партии.
   */
  readonly pluginsFromStore: boolean;
  /**
   * Разделы, которые у цели ЕСТЬ, но панель в них не пишет
   * (`writeDisabledReason`). Отдельный факт, а не отсутствие механизма: человеку,
   * который видит этот раздел у этого CLI в самой панели, ответ «такого раздела
   * у цели нет» и неверен, и бесполезен — настоящая причина в том, что состоянием
   * владеет сам CLI, и она у каталога уже записана.
   */
  readonly readOnly: { readonly hooks: boolean; readonly plugins: boolean };
  /** Умеет ли панель ЗАПУСКАТЬ этот CLI — без этого эмуляции не существует. */
  readonly panelRun: boolean;
  /** Есть ли куда поставить провод: задокументированный адрес эндпоинта. */
  readonly wire: boolean;
}

/**
 * Собрать профиль цели из её записи в каталоге.
 *
 * Механизм считается существующим, когда у провайдера есть либо универсальный
 * адаптер (`*Config`), либо объявленная собственная модель (`nativeMechanisms` —
 * так устроен Claude, у которого каждый раздел свой и богатый). Раздел, в
 * который панель НЕ ПИШЕТ (`writeDisabledReason`), механизмом переноса не
 * считается: показывать чужое он умеет, принять наше — нет.
 */
export function describeTarget(provider: ConfigProvider, level?: SectionTargets): TargetProfile {
  const own = provider.nativeMechanisms;
  // Универсальный адаптер, в который панель ПИШЕТ, — механизм переноса. Раздел
  // только для чтения им не является, и тогда в дело идёт собственная модель
  // провайдера (у Claude она и есть единственная).
  const hooksReadOnly =
    Boolean(provider.hooksConfig) && Boolean(provider.hooksConfig?.writeDisabledReason);
  const hookEvents = hooksReadOnly
    ? (own?.hookEvents ?? []).map((event) => ({ name: event.name, blocking: event.blocking }))
    : providerHookEvents(provider);

  const catalog: TargetProfile = {
    provider: provider.id,
    instructions: Boolean(
      provider.instructionsFile ?? provider.instructionsList ?? provider.instructionsRules,
    ),
    skills: {
      own: Boolean(provider.skillsConfig) || Boolean(own?.skills),
      shared: provider.skillsConfig?.alsoLoadedFrom?.() ?? [],
    },
    commands: Boolean(provider.commandsConfig) || Boolean(own?.commands),
    subagents: Boolean(own?.subagents),
    hookEvents: canonHookEvents(hookEvents),
    permissions: provider.permissionsConfig
      ? {
          model: provider.permissionsConfig.model,
          decisions: provider.permissionsConfig.decisions,
        }
      : (own?.permissions ?? { model: 'none', decisions: [] }),
    mcp: Boolean(provider.mcpConfig) || Boolean(own?.mcp),
    env: Boolean(provider.envConfig) || Boolean(own?.env),
    pluginForms: pluginFormsOf(provider),
    // Раздел плагинов есть, а принимаемых форм нет и «только для чтения» это не
    // объясняет — значит единицы приходят установкой (магазин Claude).
    pluginsFromStore: pluginFormsOf(provider).length === 0 && Boolean(own?.plugins),
    readOnly: {
      hooks: hooksReadOnly,
      plugins: Boolean(provider.pluginsConfig?.writeDisabledReason) && !own?.plugins,
    },
    panelRun: provider.assistant?.cliRunnable === true,
    wire: Boolean(provider.endpointConfig ?? provider.endpointFile),
  };

  return level ? atLevel(catalog, level) : catalog;
}

/**
 * Формы плагина, которые цель принимает как ЕДИНИЦУ.
 *
 * Выведены из задокументированных путей каталога, а не из формата строкой и тем
 * более не из идентификатора CLI: каталог файлов принимает `module`, список
 * пакетов в конфиге — `package`. Раздел, в который панель не пишет
 * (`writeDisabledReason`), не принимает ничего: показывать чужое он умеет,
 * принять наше — нет.
 *
 * Собственная модель провайдера (`nativeMechanisms.plugins` у Claude) формы НЕ
 * добавляет: плагины там ставит магазин, а установка плагинов у цели прямо вне
 * объёма партии. Видеть и перечислять их панель умеет — это чтение.
 */
function pluginFormsOf(provider: ConfigProvider): PluginForm[] {
  const config = provider.pluginsConfig;
  if (!config || config.writeDisabledReason) return [];
  // Каталог файлов у раздела есть всегда (`dir` обязателен), список пакетов —
  // только там, где он задокументирован.
  return config.configPath ? ['module', 'package'] : ['module'];
}

/**
 * Сузить профиль до разделов, которые у цели есть НА ЭТОМ УРОВНЕ (П2.5).
 *
 * Каталог описывает механизмы CLI вообще — то есть его дом. У проекта набор
 * разделов другой и он тоже задокументирован: `provider.projectConfig` называет
 * ровно те, у которых есть проектный путь. Без этого сужения приговор обещал бы
 * «нативно» разделу, которого на уровне нет: у codex переменные окружения живут
 * только в доме, и проектный перенос падал на этом построении плана —
 * `EmitMechanismMissingError` вместо честной строки отчёта.
 *
 * Ветки по идентификатору CLI здесь нет: решают поля уже посчитанных целей
 * уровня. Глобальный уровень и собственная раскладка (Claude в проекте, где
 * разделы полны, а универсальных целей нет вовсе) возвращают профиль каталога
 * НЕТРОНУТЫМ — поведение до П2.5 не меняется ни на байт.
 */
function atLevel(catalog: TargetProfile, level: SectionTargets): TargetProfile {
  if (level.scope === 'global' || level.ownLayout) return catalog;
  if (!level.supported) return nothingAtLevel(catalog.provider);

  return {
    ...catalog,
    instructions:
      catalog.instructions &&
      Boolean(level.instructionsFile ?? level.instructionsList ?? level.instructionsRules),
    skills: {
      own: catalog.skills.own && Boolean(level.skills),
      // Каталоги, которые цель читает ПОМИМО своего, — понятие дома
      // (`alsoLoadedFrom` считает от домашнего каталога): на уровне проекта
      // «запись уже лежит там, куда цель смотрит» означало бы чужой уровень.
      shared: [],
    },
    commands: catalog.commands && Boolean(level.commands),
    // Субагентов проектным путём не документирует ни один из девяти: у них это
    // раздел дома. Выдуманный проектный путь создал бы файл, которого CLI не
    // прочитает.
    subagents: false,
    hookEvents: level.hooks ? catalog.hookEvents : [],
    permissions: level.permissions ? catalog.permissions : { model: 'none', decisions: [] },
    mcp: catalog.mcp && Boolean(level.mcp),
    env: catalog.env && Boolean(level.env),
    pluginForms: level.plugins ? catalog.pluginForms : [],
    pluginsFromStore: level.plugins ? catalog.pluginsFromStore : false,
  };
}

/**
 * Уровня у цели нет вовсе: ни одного механизма. Не «ничего не умеет» по ошибке —
 * это ответ на вопрос «что доедет ТУДА», и он честно пуст. Запись, которой не
 * во что лечь, получает `impossible` с причиной, а не пропуск молчанием.
 */
function nothingAtLevel(provider: string): TargetProfile {
  return {
    provider,
    instructions: false,
    skills: { own: false, shared: [] },
    commands: false,
    subagents: false,
    hookEvents: [],
    permissions: { model: 'none', decisions: [] },
    mcp: false,
    env: false,
    pluginForms: [],
    pluginsFromStore: false,
    readOnly: { hooks: false, plugins: false },
    panelRun: false,
    wire: false,
  };
}

/**
 * Событие цели → триггер канона. Событие, которого канон не знает (`file_edited`
 * у OpenCode), НЕ подменяется ближайшим по смыслу: его просто нет в списке, и
 * запись честно уходит на уровень ниже.
 */
function canonHookEvents(
  events: readonly { name: string; blocking: boolean }[],
): { trigger: EnvTrigger; blocking: boolean }[] {
  const mapped: { trigger: EnvTrigger; blocking: boolean }[] = [];
  for (const event of events) {
    const trigger = triggerOfEvent(event.name, null);
    if (trigger) mapped.push({ trigger, blocking: event.blocking });
  }
  return mapped;
}

/** Совпадают ли триггеры по СОБЫТИЮ (матчер записи к возможностям цели не относится). */
function sameTrigger(left: EnvTrigger, right: EnvTrigger): boolean {
  if (left.on !== right.on) return false;
  if (left.on === 'session' && right.on === 'session') return left.event === right.event;
  if (left.on === 'tool' && right.on === 'tool') return left.event === right.event;
  return true;
}

/** Приговор одной записи у одной цели. Порядок разбора — по виду записи. */
export function level(item: EnvItem, target: ConfigProvider | TargetProfile): FidelityVerdict {
  const profile = 'provider' in target && 'hookEvents' in target ? target : describeTarget(target);
  // Запись, синхронизированная с аккаунтом, тела на диске не имеет — и вид
  // записи тут ни при чём: у цели нечего создавать. Разобрать её наравне с
  // файловой значит записать скилл с тем же именем и пустым содержимым, то есть
  // подменить перенос видимостью переноса.
  if (item.source.origin === 'account') return verdict('impossible', 'account_only');
  switch (item.kind) {
    case 'instructions':
      // Текст инструкций у цели без своего раздела панель подмешивает в промпт
      // своего запуска — иначе не доезжает вовсе.
      return profile.instructions
        ? verdict('native', 'target_mechanism')
        : emulatedOr(profile, 'no_mechanism');
    case 'skill':
      return skillVerdict(item, profile);
    case 'command':
      return profile.commands
        ? verdict('native', 'target_mechanism')
        : emulatedOr(profile, 'no_mechanism');
    case 'subagent':
      return profile.subagents
        ? verdict('native', 'target_mechanism')
        : emulatedOr(profile, 'no_mechanism');
    case 'hook':
      return hookVerdict(item, profile);
    case 'permission':
      return permissionVerdict(item, profile);
    case 'mcpServer':
      // Сервер внутри процесса SDK существует только в нём: переносить нечего.
      if (item.transport === 'sdk') return verdict('impossible', 'in_process_only');
      // MCP не отыгрывается ничем: набор инструментов чужого CLI панель не
      // формирует, и подсунуть его снаружи процесса нельзя.
      return profile.mcp
        ? verdict('native', 'target_mechanism')
        : verdict('impossible', 'no_mechanism');
    case 'envVar':
      return profile.env
        ? verdict('native', 'target_mechanism')
        : emulatedOr(profile, 'no_mechanism');
    case 'secret':
      // Значение секрета канон не носит (инвариант 5): ключ доезжает окружением
      // процесса при запуске — то есть ровно там, где запускает панель.
      return emulatedOr(profile, 'value_not_carried');
    case 'plugin':
      return pluginVerdict(item, profile);
    case 'panelGroup':
    case 'conversation':
      // Конструкции самой панели: у чужого CLI их нет ни у кого, и держатся они
      // на её собственном запуске.
      return emulatedOr(profile, 'panel_only_construct');
  }
}

/**
 * Приговор плагина. Плагин не отыгрывается ничем — он либо ставится у цели, либо
 * нет, — поэтому весь вопрос в ПРИЧИНЕ, а она бывает трёх разных смыслов.
 *
 * Спрашивается не «есть ли раздел», а принимает ли цель ЭТУ ФОРМУ: файл кода
 * `opencode` для Claude не плагин, а просто файл, и раздел плагинов у Claude
 * этого не меняет.
 *
 * Отказ объясняется тремя разными словами, и разница не стилистическая.
 * `installed` — единица чужого магазина: у цели нет ни её кода, ни имени
 * пакета, а выдумать имя по имени плагина значило бы угадать чужой формат;
 * содержимое при этом едет обычными записями, и общее «механизма нет» эту
 * половину правды потеряло бы. `mechanism_read_only` — раздел у цели есть, но
 * состоянием владеет сам CLI; человек видит этот раздел в самой панели, и ответ
 * «такого раздела нет» для него и неверен, и бесполезен. И только когда раздела
 * нет вовсе, причина — `no_mechanism`.
 */
function pluginVerdict(item: PluginItem, profile: TargetProfile): FidelityVerdict {
  if (profile.pluginForms.includes(item.form)) return verdict('native', 'target_mechanism');
  // Магазин с любой стороны означает одно и то же: единицу пришлось бы СТАВИТЬ.
  // Со стороны записи — она живёт в чужом магазине, и ни кода, ни имени пакета у
  // нас нет; со стороны цели — принять единицу она умеет только установкой.
  if (item.form === 'installed' || profile.pluginsFromStore) {
    return verdict('impossible', 'unit_not_installable');
  }
  return verdict('impossible', profile.readOnly.plugins ? 'mechanism_read_only' : 'no_mechanism');
}

/** Приговор скилла: свой каталог, общий каталог, эмуляция или текст. */
function skillVerdict(item: SkillItem, profile: TargetProfile): FidelityVerdict {
  // Цель читает ТОТ ЖЕ каталог, в котором скилл уже лежит (`~/.claude/skills` у
  // kimi и opencode): переносить нечего — довольно не мешать.
  if (item.dir && profile.skills.shared.some((dir) => isInside(item.dir ?? '', dir))) {
    return verdict('native', 'target_shares_location');
  }
  if (profile.skills.own) return verdict('native', 'target_mechanism');
  // Механизма нет: панель отыгрывает скилл вокруг своего запуска, а без запуска
  // остаётся текст в инструкциях — соблюдение вместо вызова.
  const asText: FidelityLevel = profile.instructions ? 'text' : 'impossible';
  if (!profile.panelRun)
    return verdict(asText, asText === 'text' ? 'no_mechanism' : 'no_panel_run');
  return { level: 'emulated', reason: 'no_mechanism', condition: THROUGH_PANEL, fallback: asText };
}

/**
 * Приговор хука — единственное место, где считаются факты рантайма.
 *
 * ПОРЯДОК РАЗБОРА не случаен, и каждый шаг закрывает свою ложь:
 *
 *  1. **Есть ли у цели ТО ЖЕ событие.** Есть — нагрузку оно отдаёт своим
 *     форматом, и это самый сильный факт из всех: он бьёт и невыведенные
 *     требования (иначе всякий хук со сложным скриптом объявлялся бы
 *     непереносимым в CLI, где он и написан).
 *  2. **Блокировка.** Запрет, попавший на наблюдательное событие, НЕ становится
 *     наблюдателем молча (инвариант 6).
 *  3. **Перенос в САМ СЕБЯ нативен по построению.** Тот же CLI — то же событие,
 *     та же нагрузка; здесь невыведенным требованиям нечего менять, и ревью
 *     волны П1 поймало ровно этот случай: два реальных хука из тринадцати
 *     объявлялись «едут проводом при включённом контуре» при переносе
 *     claude → claude.
 *  4. **Иначе — по худшему из требований**, но не дальше того, что вообще может
 *     ЗАПУСТИТЬ запись у цели: провод видит путь запроса и не видит событий
 *     сессии, поэтому предлагать контур сессионному хуку — обещание, которое
 *     контур не может сдержать ни при каких настройках.
 */
function hookVerdict(item: HookItem, profile: TargetProfile): FidelityVerdict {
  const blocks = item.blocking === 'blocks';
  const needs = item.needs;
  const facts = factsOf(needs);
  const undetermined = needs.resolution === 'undetermined';
  const event = profile.hookEvents.find((candidate) =>
    sameTrigger(candidate.trigger, item.trigger),
  );
  // Провод сидит в ПУТИ ЗАПРОСА: он видит вызовы инструментов и текст запроса —
  // и не видит ни старта сессии, ни её конца, ни сжатия контекста.
  const inRequestPath = item.trigger.on === 'tool' || item.trigger.on === 'prompt';

  if (event) {
    if (blocks && !event.blocking) return degraded(profile, 'blocking_lost', inRequestPath);
    if (!undetermined || item.source.provider === profile.provider) {
      return verdict('native', 'target_mechanism');
    }
    // Событие у чужой цели есть, но ЧТО скрипт читает из нагрузки — неизвестно,
    // а нагрузка у чужого формата своя. Нативность здесь была бы обещанием за
    // чужой счёт: под запуском панели недостающее подставляет она сама, без неё
    // остаётся сила текста — правило названо, но не принуждено.
    return panelOr(profile, 'needs_undetermined');
  }

  // Своего события у цели нет. Первым называется самый действенный факт: раздел
  // хуков, в который панель не пишет, — это НЕ «такого события нет», это «есть,
  // но состоянием владеет сам CLI», и человек увидит эту разницу в панели.
  const reason: FidelityReason = profile.readOnly.hooks
    ? 'mechanism_read_only'
    : undetermined
      ? 'needs_undetermined'
      : facts.some(isToolFact)
        ? 'tool_events_absent'
        : 'event_absent';

  let worst: FidelityVerdict | undefined;
  for (const fact of facts) {
    const candidate = factVerdict(fact, profile, reason, inRequestPath);
    worst =
      worst && worstFidelity(worst.level, candidate.level) === worst.level ? worst : candidate;
  }
  return worst ?? emulatedOr(profile, reason);
}

/** Факты вызова инструмента — те, что снаружи процесса видит только провод. */
function isToolFact(fact: EnvNeed): boolean {
  return fact === 'tool_name' || fact === 'tool_input' || fact === 'tool_result';
}

/**
 * Каким уровнем факт достаётся у цели, когда своего события у неё нет.
 *
 * Факты вызова инструмента живут ВНУТРИ чужого процесса: панель, запускающая
 * CLI, их не видит — видит только провод в пути запроса. Всё остальное (текст
 * запроса, сессия, рабочий каталог, субагент, сжатие) панель знает о СВОЁМ
 * запуске сама.
 */
function factVerdict(
  fact: EnvNeed,
  profile: TargetProfile,
  reason: FidelityReason,
  inRequestPath: boolean,
): FidelityVerdict {
  if (!isToolFact(fact)) return emulatedOr(profile, reason);
  // Факт вызова инструмента нужен, а запись живёт вне пути запроса (хук сессии,
  // которому «нужно всё сразу»): провод её не увидит даже включённым, и звать
  // контур сюда — обещание, которого он не давал. Остаётся текст.
  return inRequestPath ? wiredOr(profile, reason) : textOr(profile, reason);
}

/** Требования записи списком фактов; `undetermined` — это «нужно всё сразу». */
function factsOf(needs: EnvNeeds): readonly EnvNeed[] {
  if (needs.resolution === 'facts') return needs.facts;
  if (needs.resolution === 'undetermined') return envNeeds;
  return [];
}

/**
 * Приговор правила: правилами, режимом или ничем.
 *
 * Решение, которого у цели нет, ЗАМЕНЯЕТСЯ НАЗВАННЫМ — и замена едет в приговоре
 * полем `decision`, а не подразумевается. Без него «понижено в сторону
 * строгости» было заявлением без содержания: приговор не говорил, ВО ЧТО правило
 * превратится, а эмиттеру (П2.2) именно это и нужно записать. Хуже того,
 * инвариант 6 держался на удачном составе каталога: у цели, где из решений есть
 * один `allow`, «понижение» отправило бы `deny` в единственное доступное
 * значение — разрешение, то есть ровно снятый запрет.
 */
function permissionVerdict(item: PermissionItem, profile: TargetProfile): FidelityVerdict {
  // Режим подтверждений — настройка ВСЕГО ассистента, а не запись о вызове.
  // Правилом её не записать (такого шаблона нет ни у одной цели), а записать её
  // модом цели значило бы переставить глобальную строгость чужого CLI по
  // настройке другого — молча и во всю ширину. Ни то, ни другое: запись едет
  // рантаймом, и отчёт называет её вслух.
  if (isModeRule(item.rule)) return degraded(profile, 'no_mechanism', true);

  if (profile.permissions.model === 'rules') {
    if (profile.permissions.decisions.includes(item.decision)) {
      return { ...verdict('native', 'target_mechanism'), decision: item.decision };
    }
    const stricter = strictestAvailable(item.decision, profile.permissions.decisions);
    if (stricter) return { ...verdict('native', 'decision_downgraded'), decision: stricter };
    // Строже — нечем. Ослабить правило нельзя ни при каких условиях, значит
    // механизм цели ЭТО правило выразить не может: принудить остаётся брокеру
    // прав в пути запроса, а без провода — только текст модели.
    return degraded(profile, 'decision_unrepresentable', true);
  }
  // Режим на весь CLI (или ничего) — отдельное правило записать НЕКУДА, и это
  // один и тот же случай: механизма для ПРАВИЛА у цели нет. Принудить может
  // только брокер прав в пути запроса; без провода остаётся текст модели.
  return degraded(profile, 'no_mechanism', true);
}

/**
 * Чем заменить решение, которого у цели нет: САМОЕ СЛАБОЕ из доступных, которое
 * не слабее исходного. `ask` у цели с `allow`/`deny` становится `deny`, а не
 * `allow`; `deny` у цели без `deny` не становится ничем — такого правила там
 * просто не выразить, и приговор обязан это сказать.
 */
function strictestAvailable(
  decision: PermissionDecision,
  available: readonly PermissionDecision[],
): PermissionDecision | undefined {
  const from = permissionDecisions.indexOf(decision);
  return permissionDecisions.slice(from).find((candidate) => available.includes(candidate));
}

/**
 * Принуждение без механизма у цели: провод, иначе текст, иначе никак.
 *
 * `inRequestPath` — видит ли провод ЭТУ запись вообще. Правило прав видит всегда
 * (решение принимается на вызове инструмента), хук сессии — никогда.
 */
function degraded(
  profile: TargetProfile,
  reason: FidelityReason,
  inRequestPath: boolean,
): FidelityVerdict {
  const asText: FidelityLevel = profile.instructions ? 'text' : 'impossible';
  if (inRequestPath && profile.wire) {
    return { level: 'wired', reason, condition: THROUGH_WIRE, fallback: asText };
  }
  if (asText === 'text') return verdict('text', reason);
  return verdict('impossible', inRequestPath ? 'no_wire' : reason);
}

/** Ни события, ни провода: остаётся текст в инструкциях, а без раздела — ничего. */
function textOr(profile: TargetProfile, reason: FidelityReason): FidelityVerdict {
  return verdict(profile.instructions ? 'text' : 'impossible', reason);
}

/**
 * Уровень под запуском панели, с ТЕКСТОМ в запасе: панель подставит недостающее
 * сама, а без неё запись сохраняет силу инструкции, но не принуждения.
 */
function panelOr(profile: TargetProfile, reason: FidelityReason): FidelityVerdict {
  const asText: FidelityLevel = profile.instructions ? 'text' : 'impossible';
  if (!profile.panelRun) return verdict(asText, reason);
  return { level: 'emulated', reason, condition: THROUGH_PANEL, fallback: asText };
}

/** Уровень эмуляции, если панель умеет запускать этот CLI; иначе — названный отказ. */
function emulatedOr(profile: TargetProfile, reason: FidelityReason): FidelityVerdict {
  if (!profile.panelRun) return verdict('impossible', 'no_panel_run');
  return { level: 'emulated', reason, condition: THROUGH_PANEL, fallback: 'impossible' };
}

/** Уровень провода, если у цели есть куда его поставить; иначе — названный отказ. */
function wiredOr(profile: TargetProfile, reason: FidelityReason): FidelityVerdict {
  if (!profile.wire) return verdict('impossible', 'no_wire');
  return { level: 'wired', reason, condition: THROUGH_WIRE, fallback: 'impossible' };
}

/** Приговор без условия: уровень держится сам по себе. */
function verdict(fidelity: FidelityLevel, reason: FidelityReason): FidelityVerdict {
  return { level: fidelity, reason, condition: null, fallback: fidelity };
}

/** Лежит ли путь внутри каталога — сравнение по сегментам, а не по префиксу строки. */
function isInside(path: string, dir: string): boolean {
  const normalize = (value: string): string[] =>
    value.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  const parts = normalize(path);
  const root = normalize(dir);
  if (parts.length < root.length) return false;
  return root.every((segment, index) => segment.toLowerCase() === parts[index]?.toLowerCase());
}

/**
 * ИМЯ события у цели, отвечающее триггеру записи, — обратная сторона того же
 * отображения, которым считается уровень. Нужна эмиттеру (П2.1): записать хук
 * нельзя, не назвав событие в терминах целевого CLI.
 *
 * Живёт здесь, а не в слое эмиссии, ровно потому, что отображение одно: вторая
 * копия разошлась бы с первой молча, и матрица обещала бы «нативно» событию,
 * которого эмиттер не находит. Имена событий при этом берутся у каталога
 * (`hook-events.ts`), а не из таблицы форматов внутри домена.
 *
 * `null` — у цели такого события нет. Подменять «ближайшим по смыслу» нельзя:
 * это и есть догадка о чужом формате.
 */
export function targetEventName(provider: ConfigProvider, trigger: EnvTrigger): string | null {
  // Раздел только для чтения именем события не поможет: писать в него панель не
  // будет, и вернуть имя значило бы позвать эмиттер туда, куда ему нельзя.
  if (provider.hooksConfig?.writeDisabledReason) return null;
  for (const { name } of providerHookEvents(provider)) {
    const candidate = triggerOfEvent(name, null);
    if (candidate && sameTrigger(candidate, trigger)) return name;
  }
  return null;
}
