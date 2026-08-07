import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import type { ProjectCodeStatusProps } from './ProjectCodeStatus.types';
import styles from './ProjectCode.module.scss';

/**
 * Строка под редактором: сколько строк добавлено и убрано и чего дифф НЕ
 * показывает.
 *
 * Оговорки здесь обязательны, а не украшательство. Дифф восстанавливается по
 * правкам агента, и у восстановления есть ровно три случая, когда оно неполно:
 * файл переписан целиком, часть правок не нашлась в текущем тексте, файл
 * слишком велик для сравнения. Умолчать о любом из них — показать неполную
 * картину как полную.
 */
export function ProjectCodeStatus({ file }: ProjectCodeStatusProps) {
  const { t } = useTranslation();
  if (!file) return null;

  return (
    <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap className={styles.status}>
      {file.kind !== 'none' && !file.tooBig && (
        <Typography variant="caption" color="subtle" as="span">
          <span className={styles.added}>+{file.added}</span>{' '}
          <span className={styles.removed}>−{file.removed}</span>
        </Typography>
      )}

      {file.kind === 'none' && !file.tooBig && (
        <Typography variant="caption" color="subtle" as="span">
          {t('projectCode.noAgentEdits')}
        </Typography>
      )}

      {file.kind === 'whole-file' && <Badge tone="info">{t('projectCode.wholeFile')}</Badge>}

      {file.unmatched > 0 && (
        <Badge tone="warning">{t('projectCode.unmatched', { count: file.unmatched })}</Badge>
      )}

      {file.tooBig && <Badge tone="neutral">{t('projectCode.tooBigDiff')}</Badge>}

      {file.isReadOnly && <Badge tone="neutral">{t('projectCode.readOnly')}</Badge>}
    </Stack>
  );
}
