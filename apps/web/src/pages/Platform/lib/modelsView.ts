import type { Platform, PlatformHealthRecord } from '@agentdeck/contracts';
import {
  catalogChatModels,
  catalogDefaultModel,
  type PlatformModelSource,
} from '@agentdeck/contracts/platform-models';
import {
  foreignProviderId,
  platformRunConsumers,
} from '@agentdeck/contracts/platform-consumers';

/**
 * Карточка модели контура: что показать и что человек вправе выбрать (Т6).
 * Чистые функции — решение считается здесь, а рисуется в `ModelCard.tsx`.
 */

/** Строка «модель на потребителя»: кому, что стоит сейчас. */
export interface ConsumerModelRow {
  consumer: string;
  /** Имя провайдера у чужого CLI: «codex». Пусто — потребитель встроенный. */
  foreign: string;
  /** Переопределение этого потребителя; пусто — идёт модель контура. */
  model: string;
}

/**
 * Потребители, которым модель вообще имеет смысл переопределять: те, что ходят
 * ПРОЦЕССОМ и отмечены у контура.
 *
 * Ассистента и терминала здесь нет намеренно. Ассистент ходит управляемым
 * профилем, терминал — записанным файлом, и у обоих модель ровно одна — та, что
 * лежит в профиле. Строка «модель для терминала» обещала бы выбор, которого в
 * файле некуда положить.
 */
export function consumerModelRows(platform: Platform): ConsumerModelRow[] {
  return platform.consumers
    .filter(
      (consumer) =>
        (platformRunConsumers as readonly string[]).includes(consumer) ||
        foreignProviderId(consumer) !== undefined,
    )
    .map((consumer) => ({
      consumer,
      foreign: foreignProviderId(consumer) ?? '',
      model: platform.consumerModels[consumer] ?? '',
    }));
}

/** Идентификаторы моделей каталога, которыми можно вести разговор. */
export function catalogIds(health: PlatformHealthRecord | undefined): string[] {
  return catalogChatModels(health?.models ?? []).map((model) => model.id);
}

/**
 * Модель контура и откуда она взялась — тот же порядок, что на сервере
 * (`defaultModelOf`), но по данным карточки: выбор человека, иначе первая
 * чатовая модель каталога.
 *
 * Слабее серверной ровно в одном: модель, оставшуюся в управляемом профиле от
 * прежнего применения, карточка не видит. Поэтому она НИКОГДА не называет
 * выбором то, чего человек не выбирал, — худшее, что здесь бывает, это
 * «первая из каталога» там, где на самом деле уедет модель профиля.
 */
export function cardModel(
  platform: Platform,
  health: PlatformHealthRecord | undefined,
): { model: string; source: PlatformModelSource } {
  const chosen = platform.defaultModel.trim();
  if (chosen) return { model: chosen, source: 'default' };
  const first = catalogDefaultModel(health?.models ?? [])?.id;
  return first ? { model: first, source: 'catalog' } : { model: '', source: 'none' };
}

/**
 * Значение, которое сохранено и ДЕЙСТВУЕТ, но в каталоге последней пробы его
 * нет: модель сняли с публикации, права ключа сузили, настройку перенесли с
 * другой машины и проба ещё не проходила.
 *
 * Ревью Т6 (B2): такое значение просто исчезало из выпадающего списка, и
 * человек читал «Модели пока нет» / «Как у контура» — при том что именно эта
 * модель уезжает в профиль, в конфигурации CLI и в каждый прогон. Узнать
 * правду можно было только из `state.json`, а любое касание списка затирало
 * невидимую настройку.
 */
export function missingFromCatalog(catalog: readonly string[], model: string): boolean {
  const value = model.trim();
  return Boolean(value) && !catalog.includes(value);
}

/** Карта соответствия строками: словарь для показа и правки. */
export interface ModelMapRow {
  from: string;
  to: string;
  /** Справа стоит модель, которой в каталоге больше нет. */
  missing: boolean;
}

/**
 * Строки карты для показа. Правая часть сверяется с каталогом на КАЖДОМ показе:
 * при добавлении выбор ограничен каталогом, но каталог меняется, и строка,
 * молча переводящая в исчезнувшую модель, — это 404 без единого слова.
 */
export function mapRows(platform: Platform, catalog: readonly string[] = []): ModelMapRow[] {
  return Object.entries(platform.modelMap).map(([from, to]) => ({
    from,
    to,
    missing: catalog.length > 0 && missingFromCatalog(catalog, to),
  }));
}

/**
 * Записать строку карты. Пустое имя слева не сохраняется вовсе: ключ, которого
 * не бывает, тихо переводил бы ничто во что-то.
 *
 * Ключ, отличающийся только регистром, ЗАМЕНЯЕТСЯ: перевод ищется
 * регистронезависимо и берёт первое совпадение, поэтому строки «sonnet» и
 * «Sonnet» выглядели бы двумя настройками, а действовала бы одна — и какая,
 * видно не было.
 */
export function withMapRow(platform: Platform, from: string, to: string): Platform {
  const key = from.trim();
  if (!key) return platform;
  const next = { ...platform.modelMap };
  for (const existing of Object.keys(next)) {
    if (existing.toLowerCase() === key.toLowerCase()) delete next[existing];
  }
  next[key] = to.trim();
  return { ...platform, modelMap: next };
}

export function withoutMapRow(platform: Platform, from: string): Platform {
  const next = { ...platform.modelMap };
  delete next[from];
  return { ...platform, modelMap: next };
}

/**
 * Переопределение модели потребителя. Пустое значение УДАЛЯЕТ строку, а не
 * пишет пустоту: пустая строка в словаре читалась бы как «модели нет», и
 * прогон ушёл бы без модели вовсе.
 */
export function withConsumerModel(platform: Platform, consumer: string, model: string): Platform {
  const next = { ...platform.consumerModels };
  if (model.trim()) next[consumer] = model.trim();
  else delete next[consumer];
  return { ...platform, consumerModels: next };
}
