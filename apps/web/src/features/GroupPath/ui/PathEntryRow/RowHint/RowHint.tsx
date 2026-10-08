import type { RowHintProps } from '../PathEntryRow.types';
import { useTranslation } from 'react-i18next';
import { StepHint } from '../../StepHint/StepHint';
import { RowTextView } from '../../RowTextView/RowTextView';

/**
 * Подсказка строки на языке интерфейса. Слов нет, а строка — ресурс: спросим
 * его сводку, но только у показанной подсказки — промах кэша стоит модели.
 */
export function RowHint({ id, isShown, words, fallback }: RowHintProps) {
  const { t } = useTranslation();
  let body = words.hint;
  if (!body && words.isDescribing) body = t('groupBuilder.describing');
  return (
    <StepHint id={id} isShown={isShown}>
      {body && <span>{body}</span>}
      {!body && fallback && isShown && <RowTextView text={fallback} variant="hint" />}
      {!body && !fallback && <span>{t('groupBuilder.noLine')}</span>}
    </StepHint>
  );
}
