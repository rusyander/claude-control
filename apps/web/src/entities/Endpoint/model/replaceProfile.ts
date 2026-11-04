import type { EndpointProfile } from '@agentdeck/contracts';

/**
 * Правка формы профиля поверх СВЕЖЕГО списка (не мутируя его): переносятся только
 * поля, которые правка поменяла относительно показанного профиля. Форма отдаёт
 * профиль целиком (`{ ...profile, name }`), и вторая быстрая правка, собранная из
 * той же отрисовки, иначе вернула бы прежнее значение поля, поменянного первой.
 */
export function mergeProfileEdit(
  profiles: EndpointProfile[],
  shown: EndpointProfile,
  edited: EndpointProfile,
): EndpointProfile[] {
  const changes = Object.fromEntries(
    Object.entries(edited).filter(
      ([key, value]) =>
        JSON.stringify(value) !== JSON.stringify(shown[key as keyof EndpointProfile]),
    ),
  ) as Partial<EndpointProfile>;
  return profiles.map((item) => (item.id === edited.id ? { ...item, ...changes } : item));
}

/**
 * Какой профиль показывать в форме: набранный (`typed`) или из настроек.
 *
 * Поле формы управляемое, а кеш запросов оповещает отрисовку не сразу, а
 * следующей задачей. Быстрый набор успевал ввести букву раньше этой отрисовки,
 * и React возвращал полю прежнее значение — буква пропадала («hp/1.00.180»
 * вместо адреса). Набранное держится в состоянии карточки, обновляемом сразу,
 * и снимается, когда настройки его догнали (`sameProfile`).
 */
export function shownProfile(
  active: EndpointProfile | undefined,
  typed: EndpointProfile | null,
): EndpointProfile | undefined {
  return active && typed && typed.id === active.id ? typed : active;
}

/** Профили равны по всем полям — настройки догнали набранное. */
export function sameProfile(a: EndpointProfile, b: EndpointProfile): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof EndpointProfile>;
  return [...keys].every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
}
