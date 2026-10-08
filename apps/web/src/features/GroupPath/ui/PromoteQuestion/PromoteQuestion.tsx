import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import type { PromoteQuestionProps } from './PromoteQuestion.types';
import styles from './PromoteQuestion.module.scss';

/**
 * Последний вопрос окна шага: сделать ли его ресурсом — общим у глобальной
 * группы, файлом `.claude` проекта у проектной. Шаг уже
 * сохранён — отказ ничего не теряет, согласие создаёт файл обычными писателями
 * ресурсов (с копией) и добавляет его в группу участником.
 */
export function PromoteQuestion({
  promote,
  isPending,
  projectPath,
  onAccept,
  onDecline,
}: PromoteQuestionProps) {
  const { t } = useTranslation();
  const type = t(`groupPath.resource_${promote.type}`);

  return (
    <Stack gap="var(--spacing-md)">
      <Typography variant="body-sm" className={styles.text}>
        {/* Куда ляжет файл, решает область группы — проектная пишет в свой проект. */}
        {projectPath
          ? t('groupPath.composer.promoteTextProject', { type, project: projectPath })
          : t('groupPath.composer.promoteText', { type })}
      </Typography>
      <Stack gap="var(--spacing-2xs)">
        <Typography variant="caption" color="subtle">
          {t('groupPath.composer.promoteDraft')}
        </Typography>
        <pre className={styles.draft} tabIndex={0}>
          {promote.draft}
        </pre>
      </Stack>
      <Stack direction="row" gap="var(--spacing-xs)" justify="end" wrap>
        <Button onClick={onDecline} disabled={isPending}>
          {t('groupPath.composer.promoteNo')}
        </Button>
        <Button variant="primary" isLoading={isPending} onClick={onAccept}>
          {t('groupPath.composer.promoteYes', { type })}
        </Button>
      </Stack>
    </Stack>
  );
}
