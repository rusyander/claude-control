import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AnimatePresence } from 'motion/react';
import { useToasts } from '@shared/lib/toast';
import { ToastItem } from './toast-item';
import { ToastDetailsModal } from './toast-details-modal';
import { useToastHost } from './toast-host';
import type { ToastDetails } from './toast-details-modal.types';
import styles from './toast.module.scss';

/**
 * Контейнер уведомлений. Монтируется один раз в корне приложения и рисует все
 * тосты через портал поверх страницы. Стопка прижата к правому нижнему углу:
 * самый старый сверху, свежий появляется снизу, у самого угла.
 *
 * Пустой контейнер в DOM не держим — рисуем список только когда есть что показать.
 *
 * Полный текст живёт здесь, а не в карточке: тост уходит через три секунды, а
 * окно должно пережить его исчезновение — поэтому в состояние кладётся копия
 * текста, а не ссылка на живой тост.
 */
export function Toaster() {
  const { t } = useTranslation();
  const { toasts, dismiss } = useToasts();
  const [details, setDetails] = useState<ToastDetails | null>(null);
  // Открыто модальное окно — стопка внутри него (`toast-host.ts`) и вверху экрана: внизу справа
  // у окна кнопки подвала («Сохранить», «В очередь»), и тост ложился ровно на них.
  const dialog = useToastHost();

  return (
    <>
      {createPortal(
        <ol
          className={[styles.viewport, dialog ? styles.inDialog : ''].filter(Boolean).join(' ')}
          aria-label={t('notifications.title')}
          data-toast-host={dialog ? 'dialog' : 'page'}
        >
          <AnimatePresence initial={false}>
            {toasts.map((toast) => (
              <ToastItem
                key={toast.id}
                toast={toast}
                onDismiss={dismiss}
                onShowDetails={setDetails}
              />
            ))}
          </AnimatePresence>
        </ol>,
        dialog ?? document.body,
      )}

      <ToastDetailsModal details={details} onClose={() => setDetails(null)} />
    </>
  );
}
