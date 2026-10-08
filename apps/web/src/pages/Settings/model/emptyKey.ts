import type { ModelCatalogResponse } from '@agentdeck/contracts';

/**
 * Чем объяснить пустой список.
 *
 * Пусто у контура и пусто у models.dev — разные беды: первое значит «ключу не
 * выдано ни одной модели» (ответ контура, который сервер намеренно не
 * подменяет), второе — «источник не отвечал». Общая строка про «не ответил»
 * стояла бы прямо под подписью «источник: контур, проверен тогда-то» и гнала бы
 * человека чинить сеть вместо прав ключа.
 */
export function emptyKey(catalog: ModelCatalogResponse): string {
  return catalog.source === 'platform' ? 'models.emptyPlatform' : 'models.empty';
}
