import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '@entities/AppConfig';
import { useSplitSettings } from '@entities/ProjectGit';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SplitSettings } from './SplitSettings';
import type { DeliveryControlProps } from './SplitSettings.types';
import styles from './DeliveryControl.module.scss';

/**
 * Кнопка «До MR» в шапке чата проекта: состояние доставки на виду, настройка —
 * по нажатию.
 *
 * Раньше та же настройка жила в поповере ветки → «Параллельные ветки» →
 * свёрнутый блок, и найти её не удалось даже тому, кто о ней знал (24.09.2026).
 * Здесь подпись кнопки сама говорит, что будет со следующей задачей: «вкл»,
 * «выкл» или «некуда» — без удалённого репозитория MR создать негде.
 *
 * Главный выключатель в настройках панели убирает кнопку совсем; каталог не
 * репозиторий — тоже: доставлять там нечего.
 */
export function DeliveryControl({ path, groupDeliver }: DeliveryControlProps) {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const enabled = settings?.deliverToMr ?? true;
  const query = useSplitSettings(enabled ? path : undefined);
  const [isOpen, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const view = query.data;
  if (!enabled || !view || !view.profile.repo) return null;

  // В чате группы подпись — её решение из плана: настройка проекта по пути
  // копии с ним расходится (живой прогон 25.09, O2). Внутри — проектная.
  const deliver = groupDeliver ?? view.deliver;
  const state = deliver ? 'buttonOn' : 'buttonOff';
  const label = t(`chat.delivery.${view.profile.remote ? state : 'buttonNoRemote'}`);

  const close = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div
      className={styles.wrap}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && isOpen) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <Button
        ref={triggerRef}
        variant={deliver && view.profile.remote ? 'secondary' : 'ghost'}
        size="sm"
        leftIcon={<Icon name="branch" size={20} />}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        title={t(
          groupDeliver === undefined ? 'chat.delivery.buttonHint' : 'chat.delivery.groupHint',
        )}
      >
        {label}
      </Button>

      {isOpen && (
        <>
          <div className={styles.backdrop} onClick={() => setOpen(false)} aria-hidden="true" />
          <div className={styles.panel} role="dialog" aria-label={t('chat.delivery.title')}>
            <Typography variant="caption" color="subtle" as="span" className={styles.title}>
              {t('chat.delivery.title')}
            </Typography>
            <SplitSettings path={path} view={view} />
          </div>
        </>
      )}
    </div>
  );
}
