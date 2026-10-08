import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import type { SourceLineProps } from './SourceLine.types';
import styles from './SourceLine.module.scss';

/**
 * Откуда вкладка берёт данные и можно ли их здесь править.
 *
 * Стоит первой строкой КАЖДОЙ вкладки: раньше «только чтение» было подписью у
 * одной из четырёх, и о трёх остальных человек догадывался по кнопкам. Пометка
 * несёт не только цвет — у неё значок и слово, скринридер читает слово.
 */
export function SourceLine({ isEditable, path }: SourceLineProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.source}>
      <Badge tone={isEditable ? 'success' : 'neutral'}>
        <span className={styles.sourceMark}>
          <Icon name={isEditable ? 'edit' : 'lock'} size={14} />
          {isEditable ? t('projectsPage.editable') : t('projectsPage.readOnly')}
        </span>
      </Badge>
      <Typography variant="mono" color="subtle" as="span" className={styles.sourcePath}>
        {path}
      </Typography>
    </div>
  );
}
