import { useTranslation } from 'react-i18next';
import { Icon } from '@shared/ui/icon';
import type { TaskRowProps } from './ChatProgressSheet.types';
import styles from './ChatProgressSheet.module.scss';

export function TaskRow({ task }: TaskRowProps) {
  const { t } = useTranslation();

  return (
    <li className={`${styles.task} ${styles[task.status]}`}>
      <Icon name={task.status === 'completed' ? 'check' : 'chevronRight'} size={16} />
      <span>{task.text}</span>
      <span className={styles.taskStatus}>{t(`chat.progress.status.${task.status}`)}</span>
    </li>
  );
}
