import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import type { PathAddSlotProps } from './PathAddSlot.types';
import styles from './PathAddSlot.module.scss';

/**
 * «+» между двумя строками. Отдельный элемент списка без номера: он не шаг, а
 * место, куда шаг встанет, — вставкой или переносом. Пока ничего не
 * происходит, место почти невидимо (восемьдесят ярких «+» перекричали бы
 * шаги): его проявляют наведение на соседнюю строку, фокус, работа с
 * клавиатуры и сенсорный экран. Во время переноса место — линия «положить сюда».
 */
export function PathAddSlot({
  label,
  afterIndex,
  isDropping,
  isDropTarget,
  onAdd,
}: PathAddSlotProps) {
  const { t } = useTranslation();
  const state = isDropTarget ? styles.target : '';
  return (
    <li
      className={`${styles.slot} ${isDropping ? styles.dropping : ''} ${state}`}
      data-drop-after={afterIndex}
    >
      <span className={styles.line} />
      {isDropTarget ? (
        <span className={styles.dropLabel}>{t('groupBuilder.drag.dropHere')}</span>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={<Icon name="plus" size={16} />}
          aria-label={label}
          title={label}
          disabled={isDropping}
          onClick={onAdd}
        />
      )}
      <span className={styles.line} />
    </li>
  );
}
