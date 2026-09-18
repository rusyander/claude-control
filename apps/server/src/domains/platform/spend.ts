import type {
  Platform,
  ModelPricing,
  PlatformBudgetAnnounced,
  PlatformBudgetState,
  PlatformModelInfo,
  PlatformMoneyEstimate,
  PlatformSpendDay,
  PlatformSpendInfo,
  PlatformSpendRecord,
} from '@agentdeck/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import {
  costOf,
  findPricing,
  type PricingEntry,
  type PricingLookup,
} from '../analytics/pricing.ts';

/**
 * Расход через контур: постоянный учёт по дням и сверка с бюджетом.
 *
 * ВЕЛИЧИНА ОДНА, И ОНА ОЦЕНКА — деньги по НАШЕМУ справочнику цен. Второй,
 * «внутренней единицы контура» (всего токенов × 0.00001 $, справочник §9),
 * больше нет: контур тарифицирует по ценам реестра моделей, prompt и completion
 * раздельно, и модель без цены не списывает вовсе
 * (так считает сам контур). Правила у нас с ним теперь
 * одни; расходится ПРАЙС — его реестр против нашего справочника, — поэтому наша
 * цифра остаётся оценкой его цифры и подписана знаком «≈».
 *
 * ЧЕГО ПАНЕЛЬ НЕ ЗНАЕТ И НЕ ПРИДУМЫВАЕТ:
 *
 * 1. Остаток бюджета. Маршрута нет (подпись `budget-manual`), поэтому бюджет
 *    вводится руками и сравнивается с НАШИМ счётом — оценкой.
 * 2. Когда контур обнуляет свой счёт. Период живёт в админке, наружу не выходит;
 *    считаем от дня, который назвал человек, и говорим, что это оценка.
 * 3. Цену моделей компании. Платформа компании прайса не публикует (`pricing-local`), и
 *    токены модели без цены в деньги НЕ ПЕРЕВОДЯТСЯ вовсе: подставить ставку
 *    «неизвестной модели» значило бы показать выдуманное число рядом с
 *    настоящими. Шлюз, который цену в каталоге ОПУБЛИКОВАЛ (OpenRouter), считается
 *    по ней — {@link declaredPricing}; свои цены человека сильнее и её.
 *
 * 4. Исчерпан ли бюджет ключа — надёжно. У платформы компании 402 на `/v1` значит именно
 *    его, но приходит лишь в 30-секундном окне кэша проверки ключа; дальше
 *    исчерпанный ключ отклоняется 401 — тем же кодом, что и отозванный
 *    (обе причины сходятся в одной проверке ключа).
 *    Поэтому 402 — отдельная строка с тем, что назвал манифест драйвера, полосу
 *    (оценку) не красит, а 401 сопровождается оговоркой про все причины.
 */

/** Сколько дней храним. Дальше — обрезаем: учёт не архив. */
export const SPEND_DAYS_KEPT = 90;

/** Доля бюджета, после которой предупреждаем. До отказа 402, а не после. */
export const BUDGET_WARN_SHARE = 0.85;

/**
 * Сколько РАЗНЫХ имён моделей без цены помним — и не больше.
 *
 * Имя модели приходит из тела запроса КЛИЕНТА: его пишет CLI на этой машине, и
 * версионные суффиксы, опечатки в конфиге или прогон, перебирающий имена,
 * растили бы этот список без предела. Он лежит в `state.json`, который пишется
 * целиком и синхронно, и выводится на карточку одной строкой — то есть без
 * предела дорожает и запись, и экран. Токены таких моделей считаются ВСЕ
 * (`unpricedTokens`) — обрезаются только имена сверх этого числа.
 */
export const UNPRICED_MODELS_KEPT = 20;

/** Длина имени модели, которую храним. Дальше — обрезаем: это подпись, не текст. */
const MODEL_NAME_KEPT = 120;

/** Имя модели в том виде, в каком его не стыдно положить в файл и на экран. */
function modelName(model: string): string {
  return model.length > MODEL_NAME_KEPT ? `${model.slice(0, MODEL_NAME_KEPT)}…` : model;
}

/** Добавить имя, если оно новое и место ещё есть. Возвращает НОВЫЙ список. */
function withUnpriced(models: string[], model: string): string[] {
  const name = modelName(model);
  if (models.includes(name) || models.length >= UNPRICED_MODELS_KEPT) return models;
  return [...models, name];
}

/** День по МЕСТНОМУ времени: человек сверяет с админкой в своём поясе, не в UTC. */
export function spendDay(at: Date): string {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Расход одного ответа: то, что шлюз узнаёт из кадра `usage`. */
export interface SpendDelta {
  /** Модель, как её назвал запрос. Пусто — цену искать не по чему. */
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Ответ ДОШЁЛ до клиента, а счёта за него контур не прислал (MD-09). Токенов
   * у такого ответа нет и придумывать их нечем, но и молчать о нём нельзя:
   * считается отдельно, деньги и запросы не трогает.
   */
  unreported?: true;
}

const EMPTY_MONEY: PlatformMoneyEstimate = {
  usd: 0,
  pricedTokens: 0,
  unpricedTokens: 0,
  unpricedModels: [],
};

function emptyDay(day: string): PlatformSpendDay {
  return {
    day,
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    money: { ...EMPTY_MONEY, unpricedModels: [] },
  };
}

/**
 * Деньги одного ответа по нашему справочнику — либо признание, что цены нет.
 *
 * Кэш здесь нулевой намеренно: контур полей кэша не отдаёт вовсе, и выдумывать
 * их долю значило бы считать деньги по несуществующим кадрам.
 */
function moneyOf(delta: SpendDelta, lookup: PricingLookup): number | undefined {
  const price = delta.model ? findPricing(delta.model, lookup) : undefined;
  if (!price) return undefined;
  return costOf(price, {
    input: delta.promptTokens,
    output: delta.completionTokens,
    cacheRead: 0,
    cacheCreation: 0,
  });
}

/** Прибавить расход к дню. Возвращает НОВЫЙ день — старый не меняется. */
export function addToDay(
  day: PlatformSpendDay,
  delta: SpendDelta,
  lookup: PricingLookup = {},
): PlatformSpendDay {
  // Неотчитанный ответ — только счётчик. Дописать ему запрос или нулевые
  // токены значило бы выдать неполноту за посчитанный ноль: у ответа с
  // картинкой расход был, просто контур его не назвал.
  if (delta.unreported) {
    return { ...day, unreportedAnswers: (day.unreportedAnswers ?? 0) + 1 };
  }

  const usd = moneyOf(delta, lookup);
  const priced = usd !== undefined;
  const unpricedModels =
    !priced && delta.model
      ? withUnpriced(day.money.unpricedModels, delta.model)
      : [...day.money.unpricedModels];

  const totalTokens = day.totalTokens + delta.totalTokens;
  return {
    day: day.day,
    requests: day.requests + 1,
    promptTokens: day.promptTokens + delta.promptTokens,
    completionTokens: day.completionTokens + delta.completionTokens,
    totalTokens,
    // День пересобирается целиком, поэтому счётчик неотчитанных переносится
    // руками: посчитанный ответ не имеет права стереть признание неполноты.
    ...(day.unreportedAnswers ? { unreportedAnswers: day.unreportedAnswers } : {}),
    money: {
      usd: round6(day.money.usd + (usd ?? 0)),
      pricedTokens: day.money.pricedTokens + (priced ? delta.totalTokens : 0),
      unpricedTokens: day.money.unpricedTokens + (priced ? 0 : delta.totalTokens),
      unpricedModels,
    },
  };
}

/**
 * Прибавить расход к записи контура: нужный день находится или заводится,
 * лишние дни отпадают с начала.
 */
export function addSpend(
  record: PlatformSpendRecord,
  delta: SpendDelta,
  at: Date,
  lookup: PricingLookup = {},
): PlatformSpendRecord {
  const key = spendDay(at);
  const days = [...record.days];
  const index = days.findIndex((item) => item.day === key);
  const base = index >= 0 ? days[index]! : emptyDay(key);
  const next = addToDay(base, delta, lookup);

  if (index >= 0) days[index] = next;
  else days.push(next);

  // Дни держим по возрастанию: панель могла простоять выключенной, а часы —
  // отъехать назад (перевод времени, правка системного времени), и запись,
  // приехавшая «вчера» после сегодняшней, иначе оставалась бы в конце.
  days.sort((left, right) => left.day.localeCompare(right.day));

  return {
    ...record,
    days: days.length > SPEND_DAYS_KEPT ? days.slice(days.length - SPEND_DAYS_KEPT) : days,
  };
}

/** Сложить дни в одну цифру. Дни уже посчитаны — здесь только сумма. */
export function sumDays(days: PlatformSpendDay[]): PlatformSpendDay {
  // Тот же предел, что и у дня: девяносто дней по двадцать имён иначе сложились
  // бы в тысячу восемьсот строк, и вся эта простыня уехала бы на карточку.
  let unpricedModels: string[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let requests = 0;
  let usd = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;
  let unreportedAnswers = 0;

  for (const day of days) {
    requests += day.requests;
    unreportedAnswers += day.unreportedAnswers ?? 0;
    promptTokens += day.promptTokens;
    completionTokens += day.completionTokens;
    totalTokens += day.totalTokens;
    usd += day.money.usd;
    pricedTokens += day.money.pricedTokens;
    unpricedTokens += day.money.unpricedTokens;
    for (const model of day.money.unpricedModels) {
      unpricedModels = withUnpriced(unpricedModels, model);
    }
  }

  return {
    day: '',
    requests,
    promptTokens,
    completionTokens,
    totalTokens,
    ...(unreportedAnswers > 0 ? { unreportedAnswers } : {}),
    money: { usd: round6(usd), pricedTokens, unpricedTokens, unpricedModels },
  };
}

/**
 * Дни, попадающие в период бюджета. Пустая дата — «с начала учёта»: придумать
 * её за человека значило бы молча решить, какой расход не показывать.
 */
export function daysSince(days: PlatformSpendDay[], since: string): PlatformSpendDay[] {
  if (!since) return days;
  return days.filter((day) => day.day >= since);
}

/**
 * Итог по бюджету — то, по чему ветвится карточка. Поля описаны в контракте
 * ({@link PlatformBudgetState}), второй копии у них нет: экран и сервер обязаны
 * понимать «оценку» и «факт» одинаково.
 */
export function budgetVerdict(
  platform: Platform,
  record: PlatformSpendRecord,
): PlatformBudgetState {
  // compromise: budget-manual — остаток бюджета контур наружу не отдаёт: цифра введена руками, а период считается от названного человеком дня
  const period = sumDays(daysSince(record.days, platform.budgetSince));
  // Наш прайс — единственные деньги, которые панель умеет посчитать. Токены
  // моделей без цены сюда НЕ входят: их не считает и сам контур.
  const spentUsd = period.money.usd;
  const budgetUsd = platform.budgetUsd;
  const tracked = budgetUsd > 0;
  const exhausted = record.exhaustedAt !== undefined;

  return {
    spentUsd,
    budgetUsd,
    share: tracked ? Math.min(spentUsd / budgetUsd, 1) : 0,
    tracked,
    overEstimate: tracked && spentUsd >= budgetUsd,
    nearLimit: tracked && spentUsd >= budgetUsd * BUDGET_WARN_SHARE,
    exhausted,
    ...(record.exhaustedAt ? { exhaustedAt: record.exhaustedAt } : {}),
    ...(record.exhaustedScope ? { exhaustedScope: record.exhaustedScope } : {}),
    ...(record.exhaustedLevel ? { exhaustedLevel: record.exhaustedLevel } : {}),
  };
}

/**
 * Порог бюджета, о котором ещё не говорили, — и запись с проставленной отметкой.
 *
 * Считается ЗДЕСЬ, а не в шлюзе, по той же причине, по какой здесь же считается
 * сам итог: «дошли до 85 %» — вопрос учёта, а не транспорта. Отметка живёт в
 * записи (`announcedBudget`), потому что перезапуск панели не повод повторить
 * сказанное; снимается она только сменой периода (`budgetSince`) или ручным
 * сбросом — иначе цифра, гуляющая у самой границы порога, слала бы по
 * уведомлению на каждый ответ модели.
 *
 * Оба порога перейдены разом (первый же ответ дороже всего бюджета) — говорим
 * про СТАРШИЙ и отмечаем оба: два сообщения об одном и том же событии человек
 * читает как сбой панели.
 */
export interface BudgetCrossing {
  /** `over` — наша оценка дошла до бюджета; `near` — до порога внимания. */
  level: 'near' | 'over';
  share: number;
  spentUsd: number;
  budgetUsd: number;
  /** Запись с проставленными отметками — её и нужно сохранить. */
  record: PlatformSpendRecord;
}

export function budgetCrossing(
  platform: Platform,
  record: PlatformSpendRecord,
): BudgetCrossing | undefined {
  const budget = budgetVerdict(platform, record);
  if (!budget.tracked) return undefined;

  // Отметки чужого периода не значат ничего: человек, сдвинувший начало счёта,
  // считает заново, и промолчать ему про новый порог было бы враньём.
  const announced: PlatformBudgetAnnounced =
    record.announcedBudget?.since === platform.budgetSince
      ? record.announcedBudget
      : { since: platform.budgetSince };

  const level: 'near' | 'over' | undefined = budget.overEstimate
    ? announced.over
      ? undefined
      : 'over'
    : budget.nearLimit && !announced.near
      ? 'near'
      : undefined;
  if (!level) return undefined;

  return {
    level,
    share: budget.share,
    spentUsd: budget.spentUsd,
    budgetUsd: budget.budgetUsd,
    record: {
      ...record,
      announcedBudget: {
        since: platform.budgetSince,
        // Порог внимания пройден и тогда, когда оценка перепрыгнула его разом:
        // сказать о нём после «бюджет исчерпан» значило бы пугать задним числом.
        ...(announced.near || budget.nearLimit ? { near: true } : {}),
        ...(announced.over || budget.overEstimate ? { over: true } : {}),
      },
    },
  };
}

/**
 * Расход контура для экрана: период бюджета, всё время и дни как есть.
 *
 * Дни отдаются ЦЕЛИКОМ, а не обрезанные периодом: полоса бюджета и история —
 * разные вопросы, и человек, сдвинувший начало периода, обязан по-прежнему
 * видеть, что было до него.
 */
export function spendInfo(platform: Platform, record: PlatformSpendRecord): PlatformSpendInfo {
  return {
    platformId: platform.id,
    budgetSince: platform.budgetSince,
    period: sumDays(daysSince(record.days, platform.budgetSince)),
    total: sumDays(record.days),
    days: record.days,
    budget: budgetVerdict(platform, record),
  };
}

/**
 * Цены для оценки денег: свои цены человека перебивают прайс, прайс берётся
 * живой. Отдаём ФУНКЦИЮ, а не таблицу: шлюз живёт от перезапуска до
 * перезапуска, а прайс за это время успевает обновиться, и снятый однажды
 * снимок считал бы вчерашние деньги до конца дня.
 */
export function gatewayPricing(
  store: Pick<AppStore, 'getSettings'>,
  pricing: { current: () => { entries: PricingEntry[] } },
): () => PricingLookup {
  return () => ({
    overrides: store.getSettings().modelPricing,
    entries: pricing.current().entries,
  });
}

/**
 * Цены из каталога последней пробы — в форме справочника, по точному имени.
 *
 * Кэша в оценке расхода нет (см. `moneyOf`), но справочник требует его ставки;
 * не объявленная шлюзом ставка кэша берётся равной входу — так шлюз без
 * отдельной цены кэша и берёт деньги за эти токены.
 */
export function declaredPricing(
  models: readonly PlatformModelInfo[],
): Record<string, ModelPricing> {
  const declared: Record<string, ModelPricing> = {};
  for (const { id, price } of models) {
    if (!price) continue;
    declared[id.toLowerCase()] = {
      input: price.input,
      output: price.output,
      cacheRead: price.cacheRead ?? price.input,
      cacheWrite: price.cacheWrite ?? price.input,
    };
  }
  return declared;
}

/**
 * Снять отметку «бюджет исчерпан». Возвращает `false`, когда снимать было
 * нечего.
 *
 * Живёт в домене, а не в шлюзе: гасить отметку человек вправе и при выключенном
 * шлюзе — она пережила его перезапуск ровно затем, чтобы не соврать про чужой
 * бюджет.
 */
export function clearExhausted(
  store: Pick<AppStore, 'getPlatformSpend' | 'savePlatformSpend'>,
  platformId: string,
): boolean {
  const record = store.getPlatformSpend()[platformId];
  if (!record?.exhaustedAt) return false;
  const next = { ...record };
  delete next.exhaustedAt;
  delete next.exhaustedScope;
  delete next.exhaustedLevel;
  // Ручной сброс — второй и последний повод снять отметки объявленных порогов
  // (первый — смена `budgetSince`): человек, продливший бюджет в админке,
  // говорит об этом именно здесь, и следующий переход порога обязан прозвучать.
  delete next.announcedBudget;
  store.savePlatformSpend(next);
  return true;
}

/** Пустая запись — у контура, через который ещё ничего не проходило. */
export function emptySpend(platformId: string): PlatformSpendRecord {
  return { platformId, days: [] };
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
