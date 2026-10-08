import type { MemberOrderSlotProps } from '../MemberOrderList.types';
import { useTranslation } from 'react-i18next';
import styles from './OrderSlot.module.scss';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';

export function OrderSlot({ position, isActive, onInsert, className }: MemberOrderSlotProps) {
  const { t } = useTranslation();
  const label = t('groupBuilder.members.insertAt', { position: position + 1 });
  return (
    <div className={`${styles.slot} ${isActive ? styles.slotActive : ''} ${className ?? ''}`}>
      <span className={styles.slotLine} />
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon={<Icon name="plus" size={16} />}
        aria-label={label}
        aria-pressed={isActive}
        title={label}
        onClick={onInsert}
      />
      <span className={styles.slotLine} />
    </div>
  );
}
