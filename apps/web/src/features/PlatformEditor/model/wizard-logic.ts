import {
  PLATFORM_ASSISTANT_TARGET,
  type Platform,
  type PlatformCapability,
  type PlatformGatewaySettings,
  type PlatformProbeResult,
  type PlatformStatus,
} from '@agentdeck/contracts';
import { platformIdFromTitle } from '@entities/Platform';

/**
 * Решения мастера подключения без React.
 *
 * Всё, что мастер РЕШАЕТ — куда шагнуть, каким станет черновик, что считать
 * подтверждённым, что уедет на сервер, — живёт здесь и проверяется тестами. В
 * самом хуке остаётся состояние и порядок вызовов: то, что без браузера всё
 * равно не проверить.
 */

export type WizardStep = 'address' | 'token' | 'capabilities' | 'targets';

export const WIZARD_STEPS: WizardStep[] = ['address', 'token', 'capabilities', 'targets'];

/** Последний шаг остаётся последним: «Далее» на нём — не переход, а «Готово». */
export function stepAfter(step: WizardStep): WizardStep {
  const index = WIZARD_STEPS.indexOf(step);
  return WIZARD_STEPS[Math.min(index + 1, WIZARD_STEPS.length - 1)]!;
}

/** «Назад» с первого шага никуда не ведёт — закрывает мастер кнопка отмены. */
export function stepBefore(step: WizardStep): WizardStep {
  const index = WIZARD_STEPS.indexOf(step);
  return WIZARD_STEPS[Math.max(index - 1, 0)]!;
}

/**
 * Черновик после правки поля. Идентификатор идёт из имени, пока человек не
 * тронул его сам: он же кусок адреса шлюза, и придумывать его никто не обязан.
 * Тронутый однажды идентификатор имя за собой больше не тянет — иначе правка
 * названия молча уводила бы ключ, который лежит под старым.
 */
export function draftWithPatch(
  current: Platform,
  fields: Partial<Platform>,
  idTouched: boolean,
): Platform {
  const next = { ...current, ...fields };
  if (fields.title !== undefined && !idTouched) next.id = platformIdFromTitle(fields.title);
  return next;
}

/**
 * Что проба подтвердила. «Косвенно» считается подтверждением: возможность есть,
 * просто добирается до неё панель не напрямую. «Не объявлено» и «нет» — нет:
 * записать их в подтверждённые значило бы обещать непроверенное.
 */
export function confirmedCapabilities(result: PlatformProbeResult): PlatformCapability[] {
  if (result.outcome !== 'ok') return [];
  return result.capabilities
    .filter((finding) => finding.state === 'yes' || finding.state === 'indirect')
    .map((finding) => finding.id);
}

/**
 * С чего начинается выбор целей. У нового контура это ассистент панели: он
 * единственный работает через контур полностью, и открывать мастер с пустым
 * списком значило бы предлагать подключить контур, к которому ничего не
 * подключено. У существующего берётся его собственный выбор — но пустой список
 * там означает то же самое, что и у нового.
 */
export function initialTargets(existing: PlatformStatus | undefined): string[] {
  const saved = existing?.platform.targets ?? [];
  return saved.length ? [...saved] : [PLATFORM_ASSISTANT_TARGET];
}

/**
 * Включать ли шлюз перед подъёмом. Уже включённый не трогаем: лишняя запись
 * настроек — лишний перезапуск слушателя, а его сейчас слушают живые CLI.
 */
export function needsGatewayEnable(settings: PlatformGatewaySettings | undefined): boolean {
  return Boolean(settings && !settings.enabled);
}

/** Отметить или снять: один и тот же щелчок по строке списка. */
export function toggled(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

/**
 * Что уедет на сервер. Пустое поле ключа значит «не трогали»: в теле его тогда
 * нет вовсе, и сохранённый ключ остаётся на месте. Пустая строка в теле стёрла
 * бы его — а человек всего лишь правил название.
 */
export function savePayload(
  platform: Platform,
  token: string,
): { platform: Platform; token?: string } {
  const trimmed = { ...platform, baseUrl: platform.baseUrl.trim() };
  return token ? { platform: trimmed, token } : { platform: trimmed };
}

/**
 * Бюджет из набранного текста — и почему он не `Number(value)`.
 *
 * Поле управляемое, а бюджет в черновике — число. Возвращать число в поле
 * значило бы стирать незаконченный ввод: «10.» — это `Number` → `10`, точка из
 * поля исчезала, следующая цифра приписывалась к целой части, и «10.5»
 * сохранялось как 105 — десятикратный бюджет на единственном поле, с которым
 * сверяется вся полоса расхода. Поэтому текст на экране живёт своей жизнью, а
 * сюда приходит только вопрос «какое это число».
 *
 * Запятая — это точка: цифру человек берёт из админки и набирает как привык.
 * Непонятный ввод даёт ноль («не следить») и назван ошибкой под полем — молча
 * подставленная догадка была бы хуже.
 */
export function budgetFromText(value: string): { usd: number; broken: boolean } {
  const text = value.replace(',', '.').trim();
  if (text === '') return { usd: 0, broken: false };
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) return { usd: 0, broken: true };
  return { usd: parsed, broken: false };
}
