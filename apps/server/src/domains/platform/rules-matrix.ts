import type {
  Platform,
  PlatformRuleConflict,
  PlatformRuleRow,
  PlatformRules,
} from '@agentdeck/contracts';
import type { PlatformDriver } from './drivers/driver.ts';

/**
 * Правила контура и матрица конфликтов (Т7, решение Р5).
 *
 * Чистый модуль: ни сети, ни хранилища, ни знания об именах контуров. Список
 * правил приходит из МАНИФЕСТА драйвера, значения — из настройки контура,
 * состояние наших слоёв — параметрами. Поэтому и список на экране, и поля в
 * запросе, и отказ на взаимном исключении считаются одним кодом: два расчёта
 * разошлись бы молча, и человек читал бы на карточке одно, а в контур уезжало
 * бы другое.
 *
 * ПОЧЕМУ ПРАВИЛО БЕЗ ОБЪЯВЛЕНИЯ НЕ ОТПРАВЛЯЕТСЯ. Настройка живёт на контуре и
 * переживает смену драйвера (человек поменял адрес и вид контура, список
 * инструментов остался). Отправить `platform_tools` туда, где о нём не
 * объявлено, — это 400 на ровном месте у одних и молча проигнорированное поле у
 * других; и то и другое человек читает как поломку панели.
 */

/** Наша сторона конфликта. Те же идентификаторы возьмёт список слоёв Т8. */
export const OUR_RULE_IDS = {
  dlp: 'dlp',
  toolShim: 'toolShim',
  checkpoints: 'checkpoints',
  promptGate: 'promptGate',
} as const;

/**
 * Что известно о наших слоях в момент сборки матрицы.
 *
 * Сторона КОНТУРА сюда попадает ровно одна — сжатие истории, и только потому,
 * что это факт последней пробы, а не догадка. Про гардрейлы и подмену данных
 * панель не знает ничего: их включает владелец у себя, и видны они, только
 * когда сработают.
 */
export interface OurRulesState {
  /** Защита данных панели включена (маскирование значений). */
  dlp: boolean;
  /** Гейт промпта включён. */
  promptGate: boolean;
  /** Прослойка инструментов включена на этом контуре (Т5). */
  toolShim: boolean;
  /** Контур сжимает историю сам — по последней пробе (сторона КОНТУРА). */
  managedContext: boolean;
}

const THINKING_WORDS: Record<PlatformRules['enableThinking'], string> = {
  default: 'по умолчанию',
  on: 'включено',
  off: 'выключено',
};

/** Значение правила словами: что стоит сегодня. */
function valueOf(rules: PlatformRules, control: { field?: keyof PlatformRules }): string {
  if (!control.field) return '';
  if (control.field === 'enableThinking') return THINKING_WORDS[rules.enableThinking];
  const value = rules[control.field];
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * Строки списка «что контур делает с запросом».
 *
 * Порядок — манифеста: сперва то, чем распоряжаются здесь, потом то, что только
 * видно. Драйвер, не объявивший ничего (`openai-compat`), даёт пустой список, и
 * это честное «о себе не объявлено», а не «ничего не делает».
 */
export function platformRuleRows(platform: Platform, driver: PlatformDriver): PlatformRuleRow[] {
  const rules = platform.rules.platform;
  return driver.controls.map((control) => ({
    id: control.id,
    title: control.title,
    detail: control.detail,
    kind: control.kind,
    ...(control.field ? { field: control.field } : {}),
    ...(control.options ? { options: control.options } : {}),
    value: valueOf(rules, control),
    where: control.kind === 'request' ? '' : (control.where ?? 'вне панели'),
  }));
}

/** Правило объявлено драйвером (любым видом). */
function declared(driver: PlatformDriver, id: string): boolean {
  return driver.controls.some((control) => control.id === id);
}

/**
 * Матрица конфликтов: четыре ячейки, каждая со своим уровнем (Р5).
 *
 * Ячейка появляется, только если ОБЕ стороны существуют у этого контура: строка
 * про подмену данных у контура, который о подмене не объявлял, была бы
 * выдумкой. «Включены обе стороны прямо сейчас» — отдельный признак `active`:
 * правило-предупреждение человек должен прочитать и ДО того, как включит вторую
 * половину.
 */
export function ruleConflicts(
  platform: Platform,
  driver: PlatformDriver,
  ours: OurRulesState,
): PlatformRuleConflict[] {
  const rules = platform.rules.platform;
  const rows: PlatformRuleConflict[] = [];

  // Взаимное исключение — единственное на всю матрицу: два набора инструментов
  // спорят за один ход. Наш набор едет ТЕКСТОМ и собирается обратно из ответа
  // (Т5), набор контура исполняется у контура; включить оба значит получить
  // модель, которая половину хода зовёт наши инструменты, половину — чужие, и
  // ни одного не доводит до конца.
  // Сторона контура — строка ЕГО манифеста: имя списка инструментов у каждого
  // своё, и литерал платформы компании подсвечивал бы чужому контуру несуществующую строку.
  const toolsControl = driver.controls.find((control) => control.field === 'platformTools');
  if (toolsControl) {
    rows.push({
      id: 'tools',
      level: 'exclusive',
      platformRule: toolsControl.id,
      ourRule: OUR_RULE_IDS.toolShim,
      title: 'Инструменты платформы ⟷ наша прослойка инструментов',
      detail:
        'Два набора инструментов на один ход: наш едет текстом и собирается обратно из ответа, ' +
        'набор контура исполняет сам контур. Включить оба нельзя — выберите один.',
      active: rules.platformTools.length > 0 && ours.toolShim,
    });
  }

  // Не взаимоисключение, а ПОРЯДОК СЛОЁВ (Р11): наша маска обратима и идёт
  // первой, метки у неё другого вида, чем у контура. До 15.09.2026 строка
  // утверждала, что контур сам подменяет и возвращает свои метки, — проба dev
  // показала другое: по API-ключу модель видит почту, телефон и IP как есть,
  // кадров карты нет (router.py:596, `is_chat_caller`). Поэтому строка говорит
  // «не гарантирована», а маска у такого контура включается сама
  // (`data-mask.ts`).
  if (declared(driver, 'anonymization')) {
    rows.push({
      id: 'anonymization',
      level: 'info',
      platformRule: 'anonymization',
      ourRule: OUR_RULE_IDS.dlp,
      title: 'Подмена данных контура ⟷ наша маска данных',
      detail:
        'Не выбор из двух: слои складываются по порядку. По API-ключу подмена у контура не ' +
        'гарантирована — проба стенда показала запрос без подмены, а карту подмены клиенту API ' +
        'контур не отдаёт. Поэтому наша маска у такого контура включается сама: она идёт первой, ' +
        'обратима, и её метки контур не трогает. Выключать ничего не нужно.',
      // Включил ли владелец контура подмену — панель не знает: отдельного
      // маршрута нет, и узнаётся это только по сработавшему кадру. Поэтому
      // «включены обе» тут не утверждается (ревью Т7, M3).
      active: false,
      oursOnly: ours.dlp,
    });
  }

  // Предупреждение: контур сжимает историю у себя, наши контрольные точки
  // считают её целой. Это не поломка — это расхождение, о котором человек
  // узнаёт по странному «агент забыл начало задачи».
  if (declared(driver, 'managed-context')) {
    rows.push({
      id: 'compaction',
      level: 'warning',
      platformRule: 'managed-context',
      ourRule: OUR_RULE_IDS.checkpoints,
      title: 'Сжатие истории контуром ⟷ наши контрольные точки',
      detail:
        'Длинную переписку контур сжимает сам, а контрольная точка панели описывает историю ' +
        'целиком. После сжатия продолжение может не знать начала задачи — держите точку свежей.',
      // Здесь «обе стороны» сказать МОЖНО: сторона контура — факт из последней
      // пробы (`limits.managedContext`), а контрольные точки в панели есть
      // всегда. Это единственная из трёх строк, где видно обе половины.
      active: ours.managedContext,
    });
  }

  // Информация: два отказа подряд на одном и том же тексте. Ни один не лишний —
  // наш гейт ловит до отправки и объясняет правилом, контур ловит у себя и
  // отвечает 451, — но человеку стоит знать, что отказов может быть два.
  if (declared(driver, 'guardrails')) {
    rows.push({
      id: 'guardrails',
      level: 'info',
      platformRule: 'guardrails',
      ourRule: OUR_RULE_IDS.promptGate,
      title: 'Проверки содержимого контура ⟷ наш гейт промпта',
      detail:
        'Проверяют оба и по разным спискам: гейт панели откажет до отправки и назовёт правило, ' +
        'контур откажет у себя статусом 451. Второй отказ не означает, что первый не сработал.',
      // Та же причина, что у подмены: гардрейлы включает владелец контура, и
      // видны они панели только когда сработают (451 в журнале нарушений).
      active: false,
      oursOnly: ours.promptGate,
    });
  }

  return rows;
}

/**
 * Взаимное исключение, нарушенное настройкой. Пусто — противоречия нет.
 *
 * Отказом, а не тихой починкой: панель, сама выключившая прослойку при
 * сохранении списка инструментов контура, приняла бы за человека решение,
 * которого он не принимал, — и он узнал бы о нём по молчащему агенту.
 */
export function brokenExclusion(
  platform: Platform,
  driver: PlatformDriver,
): PlatformRuleConflict | undefined {
  return ruleConflicts(platform, driver, {
    dlp: false,
    promptGate: false,
    toolShim: platform.toolShim,
    managedContext: false,
  }).find((conflict) => conflict.level === 'exclusive' && conflict.active);
}

/**
 * Подмешать управляемые правила в тело запроса (Т7).
 *
 * Кладутся ТОЛЬКО поля, объявленные драйвером, и только со значением, которое
 * человек задал: пустой пресет — это «контур берёт свой», а не пустая строка в
 * запросе; размышления «по умолчанию» — это отсутствие поля, а «выключено» —
 * `false`, потому что «не отправлено» и «отправлено выключенным» у контуров
 * различаются.
 *
 * Тело не переписывается на месте: конвейер выше уже перевёл диалект, и правка
 * общего объекта скрыла бы от следа, чьё это поле.
 */
export function applyManagedRules(
  body: Record<string, unknown>,
  platform: Platform,
  driver: PlatformDriver,
): Record<string, unknown> {
  const rules = platform.rules.platform;
  const next = { ...body };

  for (const control of driver.controls) {
    if (control.kind !== 'request' || !control.field) continue;
    switch (control.field) {
      case 'platformTools':
        // Пустой список — это ВЫКЛЮЧЕНО, а не «панель промолчала»: контур,
        // ничего не получивший, берёт свои инструменты по умолчанию. Чем
        // сказать «не надо», знает манифест (ревью Т7, M2).
        if (rules.platformTools.length > 0) setWire(next, wire(control), [...rules.platformTools]);
        else if (control.whenEmpty) setWire(next, control.whenEmpty.field, control.whenEmpty.value);
        break;
      // Режим цикла без инструментов контура не значит ничего: отправить его
      // одного — значит попросить контур о цикле вызовов, которых нет.
      case 'toolMode':
        if (rules.platformTools.length > 0) setWire(next, wire(control), rules.toolMode);
        break;
      case 'generationPreset':
        if (rules.generationPreset.trim()) {
          setWire(next, wire(control), rules.generationPreset.trim());
        }
        break;
      case 'enableThinking':
        if (rules.enableThinking !== 'default') {
          setWire(next, wire(control), rules.enableThinking === 'on');
        }
        break;
    }
  }

  return next;
}

/**
 * Имя поля на проводе объявляет манифест: `id` — идентификатор СТРОКИ, и
 * драйвер вправе назвать ручку не так, как называется поле (ревью Т7, m6).
 */
function wire(control: { id: string; wireField?: string }): string {
  return control.wireField ?? control.id;
}

/**
 * Положить значение по пути на проводе. Путь с точками — вложенное поле
 * (`chat_template_kwargs.enable_thinking`): одни контуры ждут размышления полем
 * верхнего уровня, другие внутри объекта, и сказать это может только манифест.
 *
 * Объекты по дороге КОПИРУЮТСЯ, а не правятся: у клиента в них могут лежать
 * свои параметры, и их нужно дополнить, не затерев и не переписав в его теле.
 */
function setWire(body: Record<string, unknown>, path: string, value: unknown): void {
  const [head = '', ...rest] = path.split('.');
  if (rest.length === 0) {
    body[head] = value;
    return;
  }
  const inner = body[head];
  const copy = isRecord(inner) ? { ...inner } : {};
  setWire(copy, rest.join('.'), value);
  body[head] = copy;
}

function getWire(body: Record<string, unknown>, path: string): unknown {
  let current: unknown = body;
  for (const key of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Стоит ли в теле значение, которое платформа не принимает с потоком. */
export function refusesStream(body: Record<string, unknown>, driver: PlatformDriver): boolean {
  return driver.controls.some((control) => {
    const value = getWire(body, wire(control));
    return typeof value === 'string' && (control.streamless?.includes(value) ?? false);
  });
}
