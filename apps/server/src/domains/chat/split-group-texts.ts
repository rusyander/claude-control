import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { matchText, serverText } from '../../lib/server-texts.ts';

type GroupView = SplitPlanView['groups'][number];

/**
 * «Доставка не доведена: …» — строкой, которую читают и родитель, и агент, и
 * чужой CLI; пробелы (грязное дерево, ветка не отправлена, нет MR) — сами
 * шаблоны. Пишется одним шаблоном со списком через «; », а разбирается по
 * шаблонам на два и три пробела (`split-delivery-incomplete-2/-3`): так каждый
 * пробел получает свой вложенный код, и строка та же, что писалась до кодов.
 * Склейка через «; » без слов ловила бы чужие строки с тем же разделителем.
 */
export function deliveryIncompleteText(missing: readonly string[]): string {
  return serverText('split-delivery-incomplete', { missing: missing.join('; ') });
}

/**
 * Код причины сбоя группы для пульта — из сохранённой строки, как и код вопроса:
 * запись с прошлых запусков, написанная до кодов, узнаётся так же. Чужая причина
 * (текст ошибки запуска, ответ агента) шаблоном не читается и едет как есть.
 */
export function errorCodeOf(text: string): Pick<GroupView, 'errorCode' | 'errorParams'> {
  const matched = matchText(text);
  if (!matched) return {};
  return {
    errorCode: matched.messageCode,
    ...(matched.params ? { errorParams: matched.params } : {}),
  };
}

/** Коды строк «чего не хватило до доставки» — по индексу, `null` у чужой строки. */
export function deliveryMissingCodesOf(
  missing: readonly string[],
): Pick<GroupView, 'deliveryMissingCodes'> {
  const codes = missing.map((line) => matchText(line) ?? null);
  return codes.some((entry) => entry !== null) ? { deliveryMissingCodes: codes } : {};
}
