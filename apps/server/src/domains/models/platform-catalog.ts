import type { ModelInfo, PlatformHealthRecord, PlatformModelInfo } from '@agentdeck/contracts';

/**
 * Каталог моделей из ответа контура.
 *
 * Источником служит СЛЕД ПОСЛЕДНЕЙ ПРОБЫ, а не отдельная загрузка: проба уже
 * спрашивает у контура список моделей, он уже сужен правами ключа и уже лежит в
 * состоянии панели с датой. Второй кэш рядом с ним был бы вторым источником
 * правды об одном и том же — и первым же расхождением между ними.
 *
 * Отсюда же берётся и офлайн: нет сети — остаётся последний ответ контура со
 * своей датой, ровно как `models-cache.json` для models.dev. Кэш models.dev при
 * этом не трогается вовсе, поэтому переключение источника туда и обратно
 * обходится без похода в сеть.
 *
 * ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО: семейства и даты выхода. Контур их не публикует, а
 * без них автозамена дефолта («вышло новое поколение того же семейства») не
 * имеет опоры. Пустое семейство — не пробел, а отказ угадывать: подставь сюда
 * `claude-opus`, выведенный из имени модели, и панель начнёт сама переставлять
 * дефолт по выдуманному родству (инвариант 13).
 */

/**
 * Модели контура в общем виде каталога.
 *
 * `vendor` — владелец модели, как его назвал контур (`owned_by`), иначе сам
 * контур: у моделей одного ключа вендоры разные, и сваливать их в одну кучу
 * значило бы потерять единственный признак, по которому человек их различает.
 */
// compromise: pricing-local — платформа компании цен не публикует, каталог приходит без них, и деньги считаются по своему справочнику; опубликованную шлюзом цену читает drivers/catalog.ts
export function platformModels(health: PlatformHealthRecord, platformId: string): ModelInfo[] {
  const live = health.models.map((model) => toModelInfo(model, platformId));
  const retired = (health.retired ?? []).map((model) => toModelInfo(model, platformId));

  // Живые сверху, пропавшие в конце: пропавшая модель нужна как объяснение
  // («она была, её больше нет»), а не как строка, мешающая выбрать рабочую.
  return [...sortById(live), ...sortById(retired)];
}

function sortById(models: ModelInfo[]): ModelInfo[] {
  return [...models].sort((left, right) => left.id.localeCompare(right.id));
}

function toModelInfo(model: PlatformModelInfo, platformId: string): ModelInfo {
  const info: ModelInfo = {
    id: model.id,
    name: model.name ?? model.id,
    // Семейство пустое осознанно — см. заголовок файла.
    family: '',
    vendor: model.ownedBy ?? platformId,
  };

  if (model.kind) info.kind = model.kind;
  if (model.contextLimit !== undefined) info.contextLimit = model.contextLimit;
  if (model.outputLimit !== undefined) info.outputLimit = model.outputLimit;
  if (model.vision !== undefined) info.vision = model.vision;
  if (model.functionCalling !== undefined) info.functionCalling = model.functionCalling;
  if (model.jsonMode !== undefined) info.jsonMode = model.jsonMode;
  if (model.reasoning !== undefined) info.reasoning = model.reasoning;
  if (model.retired) info.retired = true;
  if (model.lastSeenAt) info.lastSeenAt = model.lastSeenAt;

  return info;
}
