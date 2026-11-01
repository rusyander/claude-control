import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@shared/ui/icon';
import type { DragHandleViewProps } from './DragHandle.types';
import styles from './DragHandle.module.scss';

/**
 * Ручка переноса шага — одна у «Порядка работы» групп и у редактора сценария ядра: тот же
 * жест, те же слова для чтения с экрана. Подсказка про клавиатуру — и во всплывающем title, и
 * в описании кнопки: без неё перенос с клавиатуры пришлось бы угадывать.
 */
export function DragHandle({ title, handle }: DragHandleViewProps) {
  const { t } = useTranslation();
  const hintId = useId();
  return (
    <button
      type="button"
      className={styles.handle}
      aria-label={t('groupBuilder.drag.handle', { title })}
      aria-describedby={hintId}
      title={t('groupBuilder.drag.handleHint')}
      {...handle}
    >
      <Icon name="grip" size={16} />
      <span id={hintId} hidden>
        {t('groupBuilder.drag.handleHint')}
      </span>
    </button>
  );
}
