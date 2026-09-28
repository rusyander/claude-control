import type { OurRules, Platform, PlatformRules, PlatformRulesApplies } from '@agentdeck/contracts';
import { defaultPlatformRules, platformRulesApplies } from '@agentdeck/contracts/platform';

/**
 * Чьи правила действуют на прогон через контур (баг 11б) — ОДИН расчёт на шлюз,
 * запуск и карточку.
 *
 * Выбор не переписывает настройку: снятая сторона хранит свои значения, и
 * человек, вернувший «оба набора», получает ровно то, что задавал раньше. Поэтому
 * здесь не правка записи, а её ДЕЙСТВУЮЩАЯ версия: контур с подменёнными
 * правилами, который читают все, кто собирает запрос или запуск.
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ ВЕТКА В КАЖДОМ ЧИТАТЕЛЕ. Правила контура
 * читают шлюз (поля запроса, путь инструментов, родные инструменты), проба
 * инструментов, план прогона и карточка; наши слои — запуск и карточка. Шесть
 * веток «если выбрано только наше» разошлись бы на первой правке, и карточка
 * обещала бы одно, а в контур уезжало бы другое — тот же урок, что у
 * `chooseRunModel`.
 */

/** Выбор этого контура; запись без поля (до выбора) — оба набора. */
export function rulesApplies(platform: Pick<Platform, 'rules'>): PlatformRulesApplies {
  const value = (platform.rules as { applies?: unknown } | undefined)?.applies;
  return platformRulesApplies.find((known) => known === value) ?? 'both';
}

/** Действуют ли правила контура — его поля уходят в запрос. */
export function contourRulesOn(platform: Pick<Platform, 'rules'>): boolean {
  return rulesApplies(platform) !== 'ours';
}

/** Действуют ли наши слои. */
export function ourRulesOn(platform: Pick<Platform, 'rules'>): boolean {
  return rulesApplies(platform) !== 'contour';
}

/**
 * Правила контура, которые действуют. «Только наши» — это умолчания: пустой
 * набор инструментов уходит тем словом, которым манифест говорит «не надо»
 * (`whenEmpty`), остальные поля не уходят вовсе, и контур берёт своё.
 */
export function effectivePlatformRules(platform: Pick<Platform, 'rules'>): PlatformRules {
  return contourRulesOn(platform) ? platform.rules.platform : defaultPlatformRules();
}

/**
 * Наши слои, которые действуют. «Только правила контура» — это снятый общий
 * выключатель: ни одного нашего слоя, какие бы частные галочки ни стояли.
 */
export function effectiveOurRules(platform: Pick<Platform, 'rules'>): OurRules {
  return ourRulesOn(platform) ? platform.rules.ours : { ...platform.rules.ours, enabled: false };
}

/**
 * Контур с действующими правилами — его и отдают дальше шлюз и запуск. Выбор
 * «оба набора» возвращает тот же объект: ничего не копируется там, где нечего
 * менять.
 */
export function effectivePlatform<T extends Pick<Platform, 'rules'>>(platform: T): T {
  if (rulesApplies(platform) === 'both') return platform;
  return {
    ...platform,
    rules: {
      ...platform.rules,
      platform: effectivePlatformRules(platform),
      ours: effectiveOurRules(platform),
    },
  };
}
