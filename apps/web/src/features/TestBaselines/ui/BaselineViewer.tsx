import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { EmptyState } from '@shared/ui/empty-state';
import { SkeletonList } from '@shared/ui/skeleton';
import { TabButton } from '@shared/ui/tab-button';
import { projectFileRawUrl } from '@entities/ProjectFile';
import { useAcceptBaseline, useTestBaselines } from '@entities/ProjectTest';
import { baselineTone, isOverThreshold, pickPoint, ratioPercent } from '../model/baselineView';
import type { BaselineViewerProps } from './BaselineViewer.types';
import styles from './TestBaselines.module.scss';

/**
 * Сверка скриншота с эталоном: было / стало / разница.
 *
 * Три картинки рядом, а не переключателем: глазами сравнивают именно так, а
 * «до» и «после» через вкладку человек сравнивает по памяти — и не замечает
 * сдвиг на пару пикселей, ради которого сверка и заведена.
 *
 * Картинки грузятся обычной ссылкой на файл проекта. Адрес несёт версию —
 * иначе перезаписанный агентом снимок остался бы на экране прежним: ответ
 * отдаётся без кэша, но у самого тега `img` кэш свой.
 */
export function BaselineViewer({
  isOpen,
  onOpenChange,
  projectPath,
  caseId,
  caseTitle,
}: BaselineViewerProps) {
  const { t } = useTranslation();
  const baselines = useTestBaselines(projectPath, isOpen ? caseId : undefined);
  const accept = useAcceptBaseline(projectPath);
  const [pointId, setPointId] = useState('');

  const points = baselines.data ?? [];
  const point = pickPoint(points, pointId);
  const version = baselines.dataUpdatedAt;

  const shot = (file: string | undefined): string =>
    file && projectPath ? projectFileRawUrl(projectPath, file, version) : '';

  const panes: { key: 'baseline' | 'actual' | 'diff'; file?: string }[] = [
    { key: 'baseline', file: point?.file },
    { key: 'actual', file: point?.actualFile },
    { key: 'diff', file: point?.diffFile },
  ];

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('tests.baseline.title')}
      description={caseTitle ?? caseId}
      size="full"
      footer={
        <Stack direction="row" gap="var(--spacing-xs)" justify="end" align="center">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
          <Button
            variant="primary"
            leftIcon={<Icon name="check" size={18} />}
            disabled={!point?.actualFile}
            isLoading={accept.isPending}
            onClick={() => point && accept.mutate({ caseId: point.caseId, pointId: point.pointId })}
          >
            {t('tests.baseline.accept')}
          </Button>
        </Stack>
      }
    >
      {baselines.isLoading && <SkeletonList rows={3} />}

      {!baselines.isLoading && points.length === 0 && (
        <EmptyState
          icon="image"
          title={t('tests.baseline.emptyTitle')}
          text={t('tests.baseline.emptyText')}
        />
      )}

      {points.length > 0 && (
        <Stack gap="var(--spacing-sm)">
          {points.length > 1 && (
            <Stack direction="row" gap="var(--spacing-2xs)" wrap>
              {points.map((item) => (
                <TabButton
                  key={item.pointId}
                  isActive={item.pointId === point?.pointId}
                  onClick={() => setPointId(item.pointId)}
                >
                  {item.pointId}
                </TabButton>
              ))}
            </Stack>
          )}

          {point && (
            <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
              <Badge tone={baselineTone(point.status)} withDot>
                {t(`tests.baseline.state.${point.status}`)}
              </Badge>
              {point.diffRatio !== undefined && (
                <Typography
                  variant="caption"
                  color={isOverThreshold(point) ? 'danger' : 'subtle'}
                  as="span"
                >
                  {t('tests.baseline.ratio', {
                    value: ratioPercent(point.diffRatio),
                    limit: ratioPercent(point.maxDiffRatio) || '—',
                  })}
                </Typography>
              )}
              {point.message && (
                <Typography variant="caption" color="danger" as="span">
                  {point.message}
                </Typography>
              )}
            </Stack>
          )}

          <div className={styles.panes}>
            {panes.map((pane) => (
              <Card key={pane.key} padding="sm">
                <Stack gap="var(--spacing-2xs)">
                  <Typography variant="caption" color="subtle">
                    {t(`tests.baseline.pane.${pane.key}`)}
                  </Typography>
                  {pane.file ? (
                    <img
                      className={styles.shot}
                      src={shot(pane.file)}
                      alt={t(`tests.baseline.pane.${pane.key}`)}
                    />
                  ) : (
                    <Typography variant="caption" color="subtle">
                      {t('tests.baseline.noShot')}
                    </Typography>
                  )}
                </Stack>
              </Card>
            ))}
          </div>
        </Stack>
      )}
    </Modal>
  );
}
