import { ourLayerIds } from '@agentdeck/contracts';
import type {
  ModelInfo,
  OurLayerId,
  PlatformRunLayers,
  PlatformRunPlan,
} from '@agentdeck/contracts';
import { chooseRunModel, modelCaptionState } from '@agentdeck/contracts/platform-models';
import type { PlatformModelChoice } from '@agentdeck/contracts/platform-models';

/**
 * Общие константы выбора модели и глубины продумывания. Живут в shared, чтобы
 * ими одинаково пользовались и пикер в шапке чата, и настройки (глобальный
 * дефолт). Логика «дефолт из настроек + локальный оверрайд чата» — на странице
 * чата (там доступны и настройки-entity, и per-chat черновик).
 */

/**
 * Алиасы моделей CLI для выбора. '' = как выберет Claude (по умолчанию).
 *
 * `fable` здесь потому, что он — верхняя ступень лестницы подбора
 * (`MODEL_RANK` в `contracts/model-cascade`), и без него потолок разговора нельзя
 * было поставить на неё иначе как конкретным именем из каталога: подбор считает
 * ранг по семейству, а список выбора о самом сильном семействе молчал. Доступ к
 * нему зависит от аккаунта — как и к любому имени из каталога, который панель
 * показывает целиком.
 */
export const MODEL_OPTIONS = ['', 'fable', 'opus', 'sonnet', 'haiku'] as const;

/** Уровни глубины продумывания (--effort). '' = по умолчанию. */
export const EFFORT_LEVELS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** «opus» → «Opus»; пусто отдаём как есть (подпишут отдельно). */
export function modelLabel(model: string): string {
  return model ? model.charAt(0).toUpperCase() + model.slice(1) : '';
}

/**
 * Список для выпадающего выбора модели по умолчанию: сперва алиасы CLI, затем
 * конкретные модели каталога.
 *
 * Алиасы и конкретные модели — разные вещи, и путать их нельзя: `opus` CLI сам
 * разворачивает в последнюю модель семейства, а `claude-opus-5` останется
 * ровно этой моделью и после выхода следующей (её потом подставит
 * автообновление). Поэтому конкретные идут отдельным блоком и подписаны id.
 *
 * Пропавшую у контура модель в выбор не кладём: в карточке каталога она
 * остаётся объяснением («была, больше нет») и кнопки «сделать по умолчанию» не
 * имеет — а выбор дефолта пишет ровно ту же настройку, и запрет, который
 * держится в одном из двух мест, не запрет. Уже выбранное значение при этом не
 * теряется: его возвращает `withCurrentValue`.
 */
export function modelSelectOptions(
  models: ModelInfo[],
  aliases: readonly string[],
  labelOfAlias: (alias: string) => string,
): Array<{ value: string; label: string }> {
  const options = aliases.map((alias) => ({ value: alias, label: labelOfAlias(alias) }));
  const known = new Set(aliases);

  for (const model of models) {
    if (model.retired || known.has(model.id)) continue;
    known.add(model.id);
    options.push({ value: model.id, label: `${model.name} · ${model.id}` });
  }

  return options;
}

/**
 * Чем прогон пойдёт через контур — по тем же двум значениям, из которых
 * собирается сам запрос: выбор ЭТОГО чата, а пусто — модель из настроек.
 *
 * Отдельной функцией, потому что ревью Т13 нашло ровно этот разрыв: шапка
 * спрашивала маршрут одним оверрайдом чата, а прогон уходил с
 * `оверрайд || дефолт настроек`. При пустом выборе («как в настройках») шапка
 * называла модель контура по умолчанию, пока уезжала модель из настроек, и
 * предупреждение о подмене молчало — badge показывал `qwen2.5:7b`, ехал
 * `qwen2.5:14b`. Шапка чужого CLI разрыва не знала: там модель чата хранится
 * готовым значением. Третьего расчёта нет: обе шапки и подпись ожидания зовут
 * эту функцию.
 */
export function platformRunChoice(
  rules: Parameters<typeof chooseRunModel>[0],
  model: string,
  defaultModel?: string,
): PlatformModelChoice {
  return chooseRunModel(rules, model || defaultModel || '');
}

/** Что сказать о модели прогона, идущего через контур (Т6). */
export interface PlatformModelCaption {
  /** Ключ словаря: подпись выбирается здесь, а не в двух шапках порознь. */
  key: 'chat.platformModel' | 'chat.platformModelReplaced' | 'chat.platformModelUnset';
  params: { title: string; asked: string; model: string };
  /** Человеку стоит присмотреться: уедет не то, что он выбрал. */
  warn: boolean;
}

/**
 * Подпись «чем прогон пойдёт через контур» — одна на обе шапки (свою и чужого
 * CLI).
 *
 * Отдельной функцией, потому что ревью Т6 нашло ровно этот разрыв: шапка
 * объявляла подмену по признаку `replaced`, а у контура без модели заменять
 * было нечем, и человек читал «имени „sonnet“ там нет, запрос уйдёт с .» — с
 * прочерком вместо модели и о подмене, которой не происходит. Три состояния
 * различаются здесь один раз, и два экрана не могут разойтись.
 */
export function platformModelCaption(
  title: string,
  choice: PlatformModelChoice,
): PlatformModelCaption {
  const params = { title, asked: choice.asked, model: choice.model };
  // Состояние выбирают КОНТРАКТЫ (`modelCaptionState`), а здесь — только слова:
  // те же три строки нужны полю ввода телефона, и вторая их развилка разошлась
  // бы с этой молча (ревью Т13). `unset` — контур модель не назначил: уедет то,
  // что выбрано в панели (или ничего, и тогда CLI пойдёт своей). Это не
  // подмена, но и не «всё в порядке» — обычно это непройденная проба, и
  // увидеть её надо до отправки сообщения.
  switch (modelCaptionState(choice)) {
    case 'unset':
      return { key: 'chat.platformModelUnset', params, warn: true };
    case 'replaced':
      return { key: 'chat.platformModelReplaced', params, warn: true };
    default:
      return { key: 'chat.platformModel', params, warn: false };
  }
}

/**
 * Подпись «прогон будет отклонён» — обязательный контур без шлюза или ключа.
 * Сервер отказывает при отправке; без этой строки человек узнал бы об отказе
 * только по ошибке в ленте, а раньше — не узнал бы вовсе: прогон молча уходил
 * в облако вендора (живое подключение 14.09.2026).
 */
export function platformRefusalCaption(
  plan: PlatformRunPlan | undefined,
): { key: 'chat.platformRefused'; params: { title: string; reason: string } } | undefined {
  if (!plan?.refused) return undefined;
  const reason = plan.reason === 'no_token' ? 'no_token' : 'gateway_down';
  return { key: 'chat.platformRefused', params: { title: plan.title, reason } };
}

/**
 * Подпись «прогон уйдёт мимо контура» — «по возможности» без шлюза или ключа.
 *
 * Решение по контуру №4: режим остаётся, только пока каждый такой уход назван в
 * шапке прямо. Без этой строки чат выглядел бы идущим через контур, а данные
 * молча уезжали бы в облако вендора — ровно то, от чего контур защищает. Причины
 * и советы — те же слова, что у отказа: чинится одно и то же.
 */
export function platformBypassCaption(
  plan: PlatformRunPlan | undefined,
): { key: 'chat.platformBypassed'; params: { title: string; reason: string } } | undefined {
  if (!plan?.bypassed) return undefined;
  const reason = plan.reason === 'no_token' ? 'no_token' : 'gateway_down';
  return { key: 'chat.platformBypassed', params: { title: plan.title, reason } };
}

/** Что сказать о наших слоях, снятых с прогона через контур (Т8). */
export interface PlatformLayersCaption {
  /** Ключ словаря: «снято вот это» или «не едет ничего нашего». */
  key: 'chat.platformLayers' | 'chat.platformLayersAll';
  /**
   * Снятые слои. Названия подставляет экран: они лежат в словаре рядом с
   * карточкой контура, и вторая их копия здесь разошлась бы с первой.
   */
  dropped: OurLayerId[];
}

/**
 * Подпись «что из нашего не поедет» — считает СЕРВЕР, здесь только выбор слов.
 *
 * Пусто, когда снимать нечего или прогон ведёт не Claude: у чужого CLI этих
 * флагов нет, сервер поля не присылает, и шапка про наши слои молчит. Молчит она
 * и на полном наборе — строка «ничего не снято» в каждом разговоре была бы шумом
 * ровно там, куда человек смотрит перед отправкой сообщения.
 */
export function platformLayersCaption(
  layers: PlatformRunLayers | undefined,
): PlatformLayersCaption | undefined {
  if (!layers || layers.dropped.length === 0) return undefined;
  const all = layers.dropped.length === ourLayerIds.length;
  return { key: all ? 'chat.platformLayersAll' : 'chat.platformLayers', dropped: layers.dropped };
}

/**
 * Гарантировать, что выбранное значение есть в списке. Каталог мог не
 * скачаться (нет сети), а модель в настройках уже стоит — без этой страховки
 * выпадающий список показал бы чужое значение вместо неё.
 */
export function withCurrentValue(
  options: Array<{ value: string; label: string }>,
  value: string,
): Array<{ value: string; label: string }> {
  if (!value || options.some((option) => option.value === value)) return options;
  return [...options, { value, label: value }];
}
