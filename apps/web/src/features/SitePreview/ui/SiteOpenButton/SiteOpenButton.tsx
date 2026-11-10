import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import type { SiteOpenButtonProps } from './SiteOpenButton.types';
import styles from './SiteOpenButton.module.scss';

/**
 * Полоса «Сайт: имя» над лентой чата (D20): есть только пока сайт проекта запущен панелью и
 * назвал адрес. Нажатие открывает окно сайта справа, повторное — закрывает его.
 */
export function SiteOpenButton({ name, url, isOpen, isOpening, onToggle }: SiteOpenButtonProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.strip}>
      <Button
        variant="ghost"
        size="sm"
        fullWidth
        className={styles.button}
        leftIcon={<Icon name="eye" size={18} />}
        aria-pressed={isOpen}
        isLoading={isOpening}
        title={t('sitePreview.openHint')}
        onClick={onToggle}
        data-site-open=""
      >
        <span className={styles.name}>{t('sitePreview.openNamed', { name })}</span>
        <span className={styles.url}>{url}</span>
      </Button>
    </div>
  );
}
