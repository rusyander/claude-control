import type { ModelInfo } from '@agentdeck/contracts';

/**
 * Список для выпадающего выбора модели по умолчанию: сперва алиасы CLI, затем
 * конкретные модели каталога.
 *
 * Алиасы и конкретные модели — разные вещи, и путать их нельзя: `opus` панель
 * перед запуском разворачивает в самую свежую модель семейства из каталога
 * (сам CLI по алиасу берёт «рекомендованную», которая отстаёт от вышедшей —
 * живой прогон 29.09, `run-routes.ts`), а `claude-opus-5` останется
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
