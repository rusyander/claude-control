import {
  PLATFORM_ASSISTANT_TARGET,
  PLATFORM_DEFAULT_CONSUMERS,
  PLATFORM_PRESETS,
  defaultOurRules,
  defaultPlatformRules,
  defaultPlatformTransport,
  isPlatformDay,
  platformDrivers,
  platformManifestError,
  platformTransportErrors,
  platformIdPattern,
  type CompromiseId,
  type Platform,
  type PlatformToolRoute,
  type PlatformApplyTarget,
  type PlatformBudgetState,
  type PlatformDriverId,
  type PlatformSpendDay,
  type PlatformStatus,
} from '@agentdeck/contracts';

/**
 * Контур на стороне клиента: черновик мастера, его проверки и порядок показа.
 *
 * Ничего, что решает сервер, здесь не повторяется. Возможности приходят пробой,
 * причины прочерков — планом применения; клиент их только раскладывает. Своей
 * правды о контуре у фронта нет ни одной — иначе экран начал бы расходиться с
 * тем, что панель на самом деле записала.
 */

/**
 * Пресеты в порядке показа — данными контракта (DRV-03), а не своим списком:
 * свой разошёлся бы с тем, что сервер согласен сохранить, на первом новом шлюзе.
 */
export const PLATFORM_DRIVERS: readonly PlatformDriverId[] = platformDrivers;

/**
 * Образец адреса: сюда идёт корень публичного API, а не адрес админки. Самая
 * частая ошибка настройки — именно вторая, и проба её НАЗЫВАЕТ, но полчаса
 * человека к тому моменту уже потрачены.
 */
export function platformBaseUrlSample(driver: PlatformDriverId): string {
  return PLATFORM_PRESETS[driver].sampleUrl;
}

/** Новый контур с заполненными по умолчанию полями. */
export function newPlatform(id: string, title: string): Platform {
  return {
    id,
    title,
    driver: 'enterprise-platform',
    baseUrl: '',
    // Выключенным: включает его человек в конце мастера, увидев, что панель
    // нашла. Включённый по умолчанию контур применился бы до первой пробы.
    enabled: false,
    mode: 'required',
    budgetUsd: 0,
    capabilities: [],
    targets: [],
    // Где работает контур (Т3): только ассистент панели. Прослойка Т5 вернула
    // CLI руки, но выбор «куда пустить контур» остаётся за человеком: молча
    // увести туда рабочий чат значило бы сменить ему модель, ничего не сказав.
    consumers: [...PLATFORM_DEFAULT_CONSUMERS],
    projectPaths: [],
    // Модель (Т6) — пустой: каталог появится только после первой пробы, и
    // выбирать её из пустого списка человеку нечем. До выбора панель берёт
    // первую чатовую модель каталога и говорит, что выбор не его.
    defaultModel: '',
    consumerModels: {},
    modelMap: {},
    // Агентов человек вносит сам и уже после подключения: их идентификаторы
    // лежат в админке компании, и спросить их у контура нечем.
    agents: [],
    budgetSince: '',
    // Прослойка инструментов и короткий промпт — по пресету драйвера: у платформа компании
    // включёнными (решение В1, без них агент через неё «работает как чат»), у
    // совместимого шлюза — нет, инструменты он принимает полем (аудит DRV-20).
    ...PLATFORM_PRESETS.enterprise-platform.defaults,
    // Правила контура (Т7) — умолчаниями контракта: список инструментов
    // платформы пуст, и пока он пуст, наверх уходит `tool_choice: "none"`.
    rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
    caCertPath: '',
    // Транспорт — как было до DRV-04/05: ключ в `Authorization: Bearer`, `/v1`
    // дописывается к адресу без версии. Нестандартный шлюз правится на шаге адреса.
    transport: defaultPlatformTransport(),
  };
}

/**
 * Идентификатор из имени: он же кусок адреса шлюза, поэтому всё, что в адресе
 * значит другое, схлопывается в дефис. Человек его не придумывает — но видит и
 * может исправить: переименование контура означает потерю ключа (он лежит под
 * старым идентификатором), и молча менять его нельзя.
 */
export function platformIdFromTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Пустая строка и строка, начинающаяся не с буквы или цифры, схемой
  // отвергаются — а имя из одной кириллицы даёт ровно такую.
  return platformIdPattern.test(slug) ? slug : '';
}

/** Какие поля черновика не пройдут схему. Ключ — имя поля, значение — код ошибки. */
export type PlatformFieldError = 'required' | 'pattern' | 'url';

export function validatePlatform(
  draft: Platform,
): Partial<Record<keyof Platform, PlatformFieldError>> {
  const errors: Partial<Record<keyof Platform, PlatformFieldError>> = {};
  if (!draft.title.trim()) errors.title = 'required';
  if (!draft.id.trim()) errors.id = 'required';
  else if (!platformIdPattern.test(draft.id)) errors.id = 'pattern';
  const url = draft.baseUrl.trim();
  if (!url) errors.baseUrl = 'required';
  else if (!isHttpUrl(url)) errors.baseUrl = 'url';
  // Дата периода бюджета — та же проверка, что и в схеме, и проверяется не
  // только вид: дни учёта сравниваются посимвольно, «01.09.2026» не отказало
  // бы, а тихо отрезало весь расход, а `2026-13-45` по виду проходит, но такого
  // дня нет — итог тот же. Отказ на форме объясняет это до сохранения.
  if (!isPlatformDay(draft.budgetSince.trim())) errors.budgetSince = 'pattern';
  // Подробности (какое поле и почему) форма берёт из `platformTransportErrors`
  // сама; здесь — только то, что сохранять такое нельзя.
  if (platformTransportErrors(draft.transport ?? defaultPlatformTransport()).length > 0) {
    errors.transport = 'pattern';
  }
  // Переопределения пресета — та же проверка, что в двери сохранения сервера.
  if (platformManifestError(draft.manifest)) errors.manifest = 'pattern';
  return errors;
}

/** Готов ли черновик к сохранению — та же проверка, что и на сервере. */
export function isPlatformValid(draft: Platform): boolean {
  return Object.keys(validatePlatform(draft)).length === 0;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Маршрут инструментов из ответа сервера. Сервер старее фронта поля не
 * присылает — тогда прежний смысл тумблера: прослойка включена или инструментов
 * нет вовсе.
 */
export function toolRouteOf(source: {
  toolRoute?: PlatformToolRoute;
  platform?: Pick<Platform, 'toolShim'>;
}): PlatformToolRoute {
  return source.toolRoute ?? (source.platform?.toolShim ? 'shim' : 'none');
}

/**
 * Подпись у цели-CLI: чем её инструменты дойдут до модели. Полем — подписывать
 * нечего; прослойкой — работает с её оговоркой; никак — собеседник без рук.
 */
export function toolRouteMark(route: PlatformToolRoute): CompromiseId | null {
  if (route === 'native') return null;
  return route === 'shim' ? 'tool-shim' : 'no-client-tools';
}

/**
 * Порядок целей в списке «Применён к»: ассистент панели, поддержанные CLI,
 * прочерки. Сортировка устойчивая — внутри группы порядок реестра провайдеров
 * сохраняется, иначе список перетасовывался бы от ответа к ответу.
 */
export function sortApplyTargets(targets: PlatformApplyTarget[]): PlatformApplyTarget[] {
  const rank = (target: PlatformApplyTarget): number => {
    if (target.targetId === PLATFORM_ASSISTANT_TARGET) return 0;
    return target.supported ? 1 : 2;
  };
  return [...targets].sort((left, right) => rank(left) - rank(right));
}

/**
 * Пустой итог по бюджету и пустой расход — на случай СЕРВЕРА СТАРЕЕ ФРОНТА.
 *
 * Обе величины появились в Т8, и панель, у которой сервер ещё не перезапущен
 * (обычное дело при `pnpm dev`), присылает карточку без них. Читать их напрямую
 * значило бы уронить весь раздел «Контур» из-за строки расхода: карточка обязана
 * промолчать, а не рухнуть, — ровно как со сводкой проверок шлюза.
 */
const NO_BUDGET: PlatformBudgetState = {
  spentUsd: 0,
  budgetUsd: 0,
  share: 0,
  tracked: false,
  overEstimate: false,
  nearLimit: false,
  exhausted: false,
};

const NO_SPEND: PlatformSpendDay = {
  day: '',
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  money: { usd: 0, pricedTokens: 0, unpricedTokens: 0, unpricedModels: [] },
};

export function platformBudgetOf(status: PlatformStatus): PlatformBudgetState {
  return (status.budget as PlatformBudgetState | undefined) ?? NO_BUDGET;
}

export function platformSpendOf(status: PlatformStatus): PlatformSpendDay {
  return (status.periodSpend as PlatformSpendDay | undefined) ?? NO_SPEND;
}

/**
 * Тревожен ли бюджет контура.
 *
 * Своего счёта у клиента больше НЕТ: бюджет считает сервер по постоянному учёту
 * (`PlatformStatus.budget`), потому что счётчик живого шлюза обнуляется вместе с
 * процессом — после перезапуска панели карточка сообщала бы «потрачено $0»
 * ключу, который уже упёрся в бюджет. Здесь остаётся только правило показа:
 * отказ контура (402) тревожен всегда, наша оценка — когда она дошла до
 * введённой цифры.
 */
export function platformBudgetAlarming(budget: PlatformBudgetState): boolean {
  return budget.exhausted || budget.overEstimate;
}

/**
 * Состояние карточки одним словом — то, по чему ветвится показ.
 *
 * `unchecked` отделён от `unreachable` намеренно: «не проверяли» и «не
 * отвечает» — разные утверждения, и второе про контур, который может работать.
 */
export type PlatformCardState = 'disabled' | 'unchecked' | 'ok' | 'unauthorized' | 'unreachable';

export function platformCardState(status: PlatformStatus): PlatformCardState {
  // Признак ровно один — `active`. Тумблер контура говорит о том же самом
  // (инвариант 1), но это ВТОРОЙ источник одного факта, и разойтись они могут:
  // настройки приезжают чужими писателями (снимок, архив переноса), и до
  // сведения панель показывала бы «на связи» с кнопкой «сделать активным» тому
  // контуру, который шлюз уже обслуживает. `disabled` здесь читается как
  // «работа идёт не через него».
  if (!status.active) return 'disabled';
  if (!status.health) return 'unchecked';
  if (status.health.outcome === 'ok') return 'ok';
  if (status.health.outcome === 'unauthorized') return 'unauthorized';
  return 'unreachable';
}
