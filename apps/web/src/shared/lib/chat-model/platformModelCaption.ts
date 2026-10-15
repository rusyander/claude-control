import type { PlatformModelChoice } from '@agentdeck/contracts/platform-models';
import { modelCaptionState } from '@agentdeck/contracts/platform-models';
import { routeKey } from './localRoute';

/** Что сказать о модели прогона, идущего через контур (Т6). */
export interface PlatformModelCaption {
  /** Ключ словаря: подпись выбирается здесь, а не в двух шапках порознь. */
  key:
    | ReturnType<typeof routeKey<'chat.platformModel'>>
    | 'chat.platformModelReplaced'
    | ReturnType<typeof routeKey<'chat.platformModelUnset'>>;
  params: { title: string; asked: string; model: string };
  /** Человеку стоит присмотреться: уедет не то, что он выбрал. */
  warn: boolean;
}

/**
 * Подпись «чем прогон пойдёт через контур» — одна на обе шапки (свою и чужого
 * CLI).
 *
 * Отдельной функцией, потому что ревью Т6 нашло ровно этот разрыв: шапка
 * объявляла подмену по признаку `replaced`, а у контура без модели заменять
 * было нечем, и человек читал «имени „sonnet“ там нет, запрос уйдёт с .» — с
 * прочерком вместо модели и о подмене, которой не происходит. Три состояния
 * различаются здесь один раз, и два экрана не могут разойтись.
 */
export function platformModelCaption(
  title: string,
  choice: PlatformModelChoice,
  /** Прогон ведёт контур локальной модели: слова «Локальная модель · llama.cpp» (L6). */
  local = false,
): PlatformModelCaption {
  const params = { title, asked: choice.asked, model: choice.model };
  // Состояние выбирают КОНТРАКТЫ (`modelCaptionState`), а здесь — только слова:
  // те же три строки нужны полю ввода телефона, и вторая их развилка разошлась
  // бы с этой молча (ревью Т13). `unset` — контур модель не назначил: уедет то,
  // что выбрано в панели (или ничего, и тогда CLI пойдёт своей). Это не
  // подмена, но и не «всё в порядке» — обычно это непройденная проба, и
  // увидеть её надо до отправки сообщения.
  switch (modelCaptionState(choice)) {
    case 'unset':
      return { key: routeKey('chat.platformModelUnset', local), params, warn: true };
    case 'replaced':
      // На локальной модели имя Claude заменяется ВСЕГДА — человек сам включил её кнопкой
      // в шапке, и жёлтое «имени claude-opus-5-5 там нет» читалось как поломка (владелец,
      // 15.10). Подпись просто называет модель, которая ответит.
      if (local) return { key: 'chat.localRoute.model', params, warn: false };
      return { key: 'chat.platformModelReplaced', params, warn: true };
    default:
      return { key: routeKey('chat.platformModel', local), params, warn: false };
  }
}
