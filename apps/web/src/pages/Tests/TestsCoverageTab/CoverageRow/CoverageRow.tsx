import type { ProjectTestCoverageItem } from '@agentdeck/contracts';
import { useTranslation } from 'react-i18next';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { toneOf } from '../../lib/toneOf';
import styles from './CoverageRow.module.scss';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { STATUS_TONE } from '@entities/ProjectTest';

/** Строка матрицы: требование, его кейсы и чем закончился последний прогон. */
export function CoverageRow({
  item,
  onCover,
  isStarting,
}: {
  item: ProjectTestCoverageItem;
  onCover: () => void;
  isStarting: boolean;
}) {
  const { t } = useTranslation();
  const isUncovered = item.cases.length === 0;

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-2xs)">
        <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
          {/* Голое число рядом со словом «не покрыто» читается как что угодно —
              приоритет, номер строки, количество дефектов. Подписываем. */}
          <Badge tone={toneOf(item)}>
            {isUncovered
              ? t('tests.coverage.uncovered')
              : t('tests.coverage.cases', { count: item.cases.length })}
          </Badge>
          {item.url ? (
            <a className={styles.runLink} href={item.url} target="_blank" rel="noreferrer noopener">
              {item.key}
            </a>
          ) : (
            <Typography variant="mono" as="span">
              {item.key}
            </Typography>
          )}
          <Typography variant="body-sm" as="span">
            {item.title ?? ''}
          </Typography>
          {item.status && (
            <Typography variant="caption" color="subtle" as="span">
              {item.status}
            </Typography>
          )}
          {/* Кнопка стоит на строке требования, а не в пульте: запуск отсюда
              несёт агенту ключ задачи, поэтому кейсы приходят уже привязанными
              к ней — ради этого столбца матрица и существует. */}
          <Button
            variant="ghost"
            size="sm"
            className={styles.coverAction}
            leftIcon={<Icon name="plus" size={16} />}
            onClick={onCover}
            disabled={isStarting}
            title={t('projectTests.generateRequirementHint')}
          >
            {t('projectTests.generateRequirement')}
          </Button>
        </Stack>

        {isUncovered ? (
          <Typography variant="caption" color="subtle">
            {t('tests.coverage.uncoveredHint')}
          </Typography>
        ) : (
          <Stack direction="row" gap="var(--spacing-2xs)" wrap>
            {item.cases.map((one) => (
              <Badge key={`${one.groupId}:${one.caseId}`} tone={STATUS_TONE[one.status]}>
                {/* Та же обрезка, что у кейсов без требования: длинное название
                    иначе выносит плашку за край карточки требования. */}
                <span className={styles.coverageCaseTitle} title={one.title}>
                  {one.muted ? `${one.title} · ${t('tests.muted.short')}` : one.title}
                </span>
              </Badge>
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
