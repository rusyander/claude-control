import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts';
import type {
  OurLayerId,
  OurRules,
  Platform,
  PlatformConflictLevel,
  PlatformRuleConflict,
  PlatformRuleRow,
  PlatformRules,
} from '@agentdeck/contracts';

/**
 * Что карточка правил показывает и что отправляет обратно (Т7).
 *
 * Чистый модуль без React: строки приходят с сервера собранными из манифеста
 * драйвера, здесь остаётся только разложить их по двум спискам и собрать
 * изменённую настройку. Решений о том, ЧТО значит правило, тут нет ни одного —
 * они в драйвере и в `rules-matrix.ts`, и второй их источник разошёлся бы с
 * первым.
 */

/**
 * Правила ЭТОГО контура, даже если их в записи нет.
 *
 * Ответ без поля приносит не сервер, а рассинхрон: панель на диске новее
 * запущенного сервера (dev), развёрнутый архив чужой машины, ответ телефона от
 * старой версии. Падать на этом нельзя — карточка утащила бы за собой весь
 * раздел, и человек увидел бы пустую страницу вместо одного пустого списка.
 */
export function platformRules(platform: Platform): PlatformRules {
  return platform.rules?.platform ?? defaultPlatformRules();
}

/**
 * Наши слои ЭТОГО контура (Т8), даже если поля в записи нет — по той же причине,
 * что и у правил выше: запись старше панели приезжает разворотом архива и с
 * телефона, и падать на ней карточке нельзя.
 */
export function ourRules(platform: Platform): OurRules {
  return platform.rules?.ours ?? defaultOurRules();
}

/**
 * Действует ли слой НА ЭКРАНЕ. Та же мысль, что в `domains/platform/layers.ts`:
 * общий выключатель сильнее частных галочек. Считать здесь нечего — это одно
 * «и», и держать ради него сетевой ответ было бы дороже, чем повторить; всё, что
 * СЛОЖНЕЕ этого (флаги запуска), карточка берёт готовым с сервера.
 */
export function layerOn(rules: OurRules, layer: OurLayerId): boolean {
  return rules.enabled && rules[layer];
}

/** Настройка контура с изменённым нашим слоем. */
export function withOurRule(platform: Platform, field: keyof OurRules, value: boolean): Platform {
  return {
    ...platform,
    rules: { ...platform.rules, ours: { ...ourRules(platform), [field]: value } },
  };
}

/** Правила, которыми распоряжается панель. */
export function managedRules(rows: readonly PlatformRuleRow[] = []): PlatformRuleRow[] {
  return rows.filter((row) => row.kind === 'request' && row.field);
}

/** Правила, которые только видно: ими распоряжается владелец контура. */
export function observedRules(rows: readonly PlatformRuleRow[] = []): PlatformRuleRow[] {
  return rows.filter((row) => row.kind === 'observed' || !row.field);
}

/** Цвет строки конфликта. Взаимное исключение — единственное красное. */
export function conflictTone(level: PlatformConflictLevel): 'danger' | 'warning' | 'info' {
  if (level === 'exclusive') return 'danger';
  return level === 'warning' ? 'warning' : 'info';
}

/**
 * Нарушенное взаимное исключение — то, из-за чего сохранение получит отказ.
 * Пусто — противоречия нет.
 */
export function blockingConflict(
  conflicts: readonly PlatformRuleConflict[] = [],
): PlatformRuleConflict | undefined {
  return conflicts.find((conflict) => conflict.level === 'exclusive' && conflict.active);
}

/**
 * Имена инструментов из одной строки ввода.
 *
 * Через запятую ИЛИ пробел: реестр контура человек переписывает глазами из
 * админки, и требовать от него одного разделителя — это отказ на ровном месте.
 * Пустые куски выбрасываются, порядок и регистр сохраняются: имя инструмента —
 * чужой идентификатор, и «поправить» его панель не вправе.
 */
export function parseToolNames(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

/** Настройка контура с изменённым правилом. */
export function withRule<K extends keyof PlatformRules>(
  platform: Platform,
  field: K,
  value: PlatformRules[K],
): Platform {
  return {
    ...platform,
    rules: { ...platform.rules, platform: { ...platformRules(platform), [field]: value } },
  };
}
