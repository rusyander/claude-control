import {
  PLATFORM_ASSISTANT_TARGET,
  PLATFORM_PRESETS,
  foreignProviderId,
  platformManifestDeclared,
  shimByClientTools,
  type Platform,
  type PlatformApplyResult,
  type PlatformApplyTarget,
  type PlatformConsumerOption,
  type PlatformManifestField,
  type PlatformManifestOverrides,
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
 *
 * Драйвер нового контура приносит свои умолчания прослойки и промпта: в мастере
 * этих галочек нет, и тронуть их человек ещё не мог. У сохранённого контура они
 * уже выбор человека (карточка правил), и смена драйвера их не переписывает.
 *
 * Переопределения пресета у нового контура при смене пресета сбрасываются: они
 * сказаны о ПРЕЖНЕМ шлюзе («у моего vLLM ручки Anthropic нет»), и молча
 * перенесённые на другой стали бы утверждением, которого никто не делал.
 *
 * Объявление инструментов у НОВОГО контура тянет за собой умолчание прослойки:
 * человек, сказавший «поле мой шлюз принимает, а модель по нему не зовёт»
 * (`native-no-call`), сказал этим и то, что руки агенту даёт только прослойка.
 * У сохранённого контура галочка — уже его выбор, и переопределение её не трогает.
 */
export function draftWithPatch(
  current: Platform,
  fields: Partial<Platform>,
  idTouched: boolean,
  isNew = false,
): Platform {
  const next = { ...current, ...fields };
  if (fields.title !== undefined && !idTouched) next.id = platformIdFromTitle(fields.title);
  if (isNew && fields.driver !== undefined && fields.driver !== current.driver) {
    Object.assign(next, PLATFORM_PRESETS[fields.driver].defaults);
    delete next.manifest;
    return next;
  }
  if (isNew && fields.manifest !== undefined) {
    next.toolShim = shimByClientTools(
      platformManifestDeclared(next.driver, next.manifest).clientTools,
    );
  }
  return next;
}

/**
 * Переопределения после правки одного поля. `undefined` убирает поле — «как у
 * пресета»; пустая строка остаётся — «не объявлено», и это разные ответы.
 * Пустой объект не хранится: у контура без переопределений поля нет вовсе.
 */
export function manifestWithField<F extends PlatformManifestField>(
  manifest: PlatformManifestOverrides | undefined,
  field: F,
  value: PlatformManifestOverrides[F] | undefined,
): PlatformManifestOverrides | undefined {
  const next: PlatformManifestOverrides = { ...manifest };
  if (value === undefined) delete next[field];
  else next[field] = value;
  return Object.keys(next).length > 0 ? next : undefined;
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
 * С чего начинается выбор ФАЙЛОВЫХ целей — тех, что пишутся в конфигурацию
 * чужого CLI.
 *
 * Ассистента панели среди них больше нет (Т3): он стал потребителем маршрута и
 * отмечается в списке «Где работает контур», а держать его ещё и галочкой цели
 * значило бы спрашивать об одном и том же дважды и получать два разных ответа.
 * Новый контур начинает с пустого списка: файлы CLI пишет потребитель
 * «Терминал», а он снят по умолчанию.
 */
export function initialTargets(existing: PlatformStatus | undefined): string[] {
  const saved = existing?.platform.targets ?? [];
  return saved.filter((target) => target !== PLATFORM_ASSISTANT_TARGET);
}

/** Сохраняемое и применяемое при «Готово» — общая функция контрактов (её зовёт и агент панели). */
export { finishPlan } from '@agentdeck/contracts';

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

/**
 * Закрывается ли мастер по «Готово» после применения (дефект D3 приёмки).
 *
 * Держать окно открытым имеет смысл ровно тогда, когда пропуск чинится В НЁМ:
 * место занято, и галочка «перезаписать» стоит под строкой цели. Остальные
 * причины здесь не чинятся — контур не активен, шлюз не поднят, у CLI нет
 * файла переменных, — и окно, которое не закрывается на «Готово», оставляло
 * человека с сохранённым контуром и кнопкой, которая «не работает». Такие
 * пропуски мастер закрывает и называет вслух (`skippedNote`).
 */
export function finishCloses(result: PlatformApplyResult): boolean {
  return !result.skipped.some((item) => item.reason === 'conflict');
}

/**
 * Файл CLI сильнее снятой галочки потребителя: переменные панель кладёт в
 * окружение процесса, а применённый файл CLI читает сам на каждом запуске.
 * Пока файл этого CLI применён, «через контур не ходить» для такого прогона не
 * выполнится — это говорится у строки, а не обещается молча.
 */
export function consumerFileWins(
  consumer: PlatformConsumerOption,
  consumers: readonly string[],
  appliedFiles: ReadonlySet<string>,
): boolean {
  return (
    consumer.scope === 'run' &&
    !consumers.includes(consumer.id) &&
    appliedFiles.has(foreignProviderId(consumer.id) ?? 'claude')
  );
}

/** Файловые цели (не ассистент), в которые контур уже записан. */
export function appliedFileTargets(targets: readonly PlatformApplyTarget[]): Set<string> {
  return new Set(
    targets
      .filter((target) => target.targetId !== PLATFORM_ASSISTANT_TARGET && target.applied)
      .map((target) => target.targetId),
  );
}
