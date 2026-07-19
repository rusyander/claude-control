import { createPortal } from 'react-dom';
import { AnimatePresence } from 'motion/react';
import { useToasts } from '@shared/lib/toast';
import { ToastItem } from './toast-item';
import styles from './toast.module.scss';

/**
 * Контейнер уведомлений. Монтируется один раз в корне приложения и рисует все
 * тосты через портал поверх страницы. Стопка закреплена в правом нижнем углу и
 * растёт вверх: новый тост появляется у угла, прежние поднимаются над ним.
 *
 * Пустой контейнер в DOM не держим — рисуем список только когда есть что показать.
 */
export function Toaster() {
  const { toasts, dismiss } = useToasts();

  return createPortal(
    <ol className={styles.viewport} aria-label="Уведомления">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </AnimatePresence>
    </ol>,
    document.body,
  );
}
