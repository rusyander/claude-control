import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import type { ProjectTestReleaseCase, ProjectTestReleaseRequirement } from '@agentdeck/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { SelectField } from '@shared/ui/select-field';
import { Typography } from '@shared/ui/typography';
import { SkeletonList } from '@shared/ui/skeleton';
import { releaseExportUrl, useTestRelease } from '@entities/ProjectTest';
import type { TestsReleaseCardProps } from './TestsReleaseCard.types';
import styles from './TestsPage.module.scss';
import { serverFieldText } from '@shared/config/i18n';

/** Цвет состояния требования: «не до конца» — предупреждение, остальное красное. */
const STATE_TONE: Record<ProjectTestReleaseRequirement['state'], 'success' | 'warning' | 'danger'> =
  {
    covered: 'success',
    partial: 'warning',
    red: 'danger',
    uncovered: 'danger',
  };

/**
 * Готовность вехи одним документом.
 *
 * Вопрос «отдаём или нет» задают вехой, а собирали ответ до сих пор из четырёх
 * вкладок. Здесь он собран один раз: вердикт первой строкой, под ним — то, что
 * мешает (непроверенное и незакрытые дефекты), и только потом доказательства.
 *
 * Экран и печать читают ОДИН документ с сервера: разойдясь однажды, они
 * перестали бы отвечать одинаково ровно на тот вопрос, ради которого документ и
 * заводили. Поэтому здесь нет ни одного своего счёта — только показ.
 */
export function TestsReleaseCard({ projectPath, releases }: TestsReleaseCardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Свежая веха выбрана сама: чаще всего спрашивают про неё, а список приходит
  // от свежей к старой.
  const [picked, setPicked] = useState('');
  const release = picked || releases[0] || '';
  const answer = useTestRelease(projectPath, release || undefined);

  if (releases.length === 0) return undefined;

  const doc = answer.data?.document;

  const openCase = (item: ProjectTestReleaseCase): void => {
    void navigate({ to: '.', search: { id: `${item.groupId}:${item.caseId}` } });
  };

  const caseList = (items: ProjectTestReleaseCase[], tone: 'danger' | 'warning' | 'neutral') => (
    <Stack gap="var(--spacing-3xs)">
      {items.slice(0, 20).map((item) => (
        <Stack
          key={`${item.groupId}:${item.caseId}`}
          direction="row"
          gap="var(--spacing-2xs)"
          align="center"
          wrap
          className={styles.failureRow}
        >
          {item.priority && <Badge tone={tone}>{t(`tests.priority.${item.priority}`)}</Badge>}
          <button type="button" className={styles.runHead} onClick={() => openCase(item)}>
            <Typography variant="body-sm" as="span">
              {item.title}
            </Typography>
          </button>
          {item.note && (
            <Typography variant="caption" color="subtle" as="span">
              {item.note}
            </Typography>
          )}
          {item.muteReason && (
            <Typography variant="caption" color="warning" as="span">
              {item.muteReason}
            </Typography>
          )}
        </Stack>
      ))}
      {items.length > 20 && (
        <Typography variant="caption" color="subtle">
          {t('tests.release.more', { count: items.length - 20 })}
        </Typography>
      )}
    </Stack>
  );

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-2xs)">
        <Stack direction="row" gap="var(--spacing-2xs)" align="end" wrap>
          <Typography variant="body-sm" weight="medium" as="span">
            {t('tests.release.title')}
          </Typography>
          <SelectField
            label={t('tests.release.pick')}
            value={release}
            onChange={setPicked}
            options={releases.map((name) => ({ value: name, label: name }))}
          />
          {/* Документ файлом — туда, где панели нет: приёмка, заказчик,
              соседняя команда. PDF печатает браузер этой машины, поэтому ссылка
              может привести к честному отказу, а не к файлу. */}
          <a className={styles.runLink} href={releaseExportUrl(projectPath, release, 'md')}>
            {t('tests.release.exportMd')}
          </a>
          <a className={styles.runLink} href={releaseExportUrl(projectPath, release, 'html')}>
            {t('tests.release.exportHtml')}
          </a>
          <a className={styles.runLink} href={releaseExportUrl(projectPath, release, 'pdf')}>
            {t('tests.release.exportPdf')}
          </a>
        </Stack>
        <Typography variant="caption" color="subtle">
          {t('tests.release.hint')}
        </Typography>

        {answer.isLoading && <SkeletonList rows={2} />}

        {doc && (
          <Stack gap="var(--spacing-2xs)">
            {/* Вердикт первой строкой: остальное — доказательства к нему. */}
            <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
              <Badge tone={doc.verdict.ready ? 'success' : 'danger'}>
                {t(doc.verdict.ready ? 'tests.release.ready' : 'tests.release.blocked')}
              </Badge>
              <Typography variant="body-sm" as="span">
                {doc.verdict.text}
              </Typography>
            </Stack>

            <Stack direction="row" gap="var(--spacing-2xs)" wrap>
              <Badge tone="neutral">{t('tests.release.cases', { count: doc.totals.cases })}</Badge>
              <Badge tone="success">
                {t('tests.release.passed', { count: doc.totals.passed })}
              </Badge>
              <Badge tone={doc.totals.failed > 0 ? 'danger' : 'neutral'}>
                {t('tests.release.failed', { count: doc.totals.failed })}
              </Badge>
              <Badge tone={doc.totals.untested > 0 ? 'warning' : 'success'}>
                {t('tests.release.untested', { count: doc.totals.untested })}
              </Badge>
              <Badge tone={doc.defects.length > 0 ? 'danger' : 'neutral'}>
                {t('tests.release.defects', { count: doc.defects.length })}
              </Badge>
              <Badge tone="info">{t('tests.release.runs', { count: doc.totals.runs })}</Badge>
              {doc.totals.muted > 0 && (
                <Badge tone="warning">
                  {t('tests.release.muted', { count: doc.totals.muted })}
                </Badge>
              )}
            </Stack>

            {doc.untested.length > 0 && (
              <Stack gap="var(--spacing-3xs)">
                <Typography variant="body-sm" weight="medium">
                  {t('tests.release.untestedTitle', { count: doc.untested.length })}
                </Typography>
                {caseList(doc.untested, 'warning')}
              </Stack>
            )}

            {doc.defects.length > 0 && (
              <Stack gap="var(--spacing-3xs)">
                <Typography variant="body-sm" weight="medium">
                  {t('tests.release.defectsTitle', { count: doc.defects.length })}
                </Typography>
                {doc.defects.slice(0, 20).map((item) => (
                  <Stack
                    key={`${item.groupId}:${item.caseId}:${item.url}`}
                    direction="row"
                    gap="var(--spacing-2xs)"
                    align="center"
                    wrap
                    className={styles.failureRow}
                  >
                    <Badge tone={item.state === 'open' ? 'danger' : 'neutral'}>
                      {item.stateLabel ?? t(`tests.release.defectState.${item.state}`)}
                    </Badge>
                    <a
                      className={styles.runLink}
                      href={item.url}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {item.title ?? item.key ?? item.url}
                    </a>
                    <Typography variant="caption" color="subtle" as="span">
                      {item.caseTitle}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            )}

            {doc.red.length > 0 && (
              <Stack gap="var(--spacing-3xs)">
                <Typography variant="body-sm" weight="medium">
                  {t('tests.release.redTitle', { count: doc.red.length })}
                </Typography>
                {caseList(doc.red, 'danger')}
              </Stack>
            )}

            {doc.muted.length > 0 && (
              <Stack gap="var(--spacing-3xs)">
                <Typography variant="body-sm" weight="medium">
                  {t('tests.release.mutedTitle', { count: doc.muted.length })}
                </Typography>
                {caseList(doc.muted, 'neutral')}
              </Stack>
            )}

            {doc.requirements.length > 0 && (
              <Stack gap="var(--spacing-3xs)">
                <Typography variant="body-sm" weight="medium">
                  {t('tests.release.requirements', { count: doc.requirements.length })}
                </Typography>
                {doc.requirements.slice(0, 20).map((item) => (
                  <Stack
                    key={item.key}
                    direction="row"
                    gap="var(--spacing-2xs)"
                    align="center"
                    wrap
                    className={styles.failureRow}
                  >
                    <Badge tone={STATE_TONE[item.state]}>
                      {t(`tests.release.state.${item.state}`)}
                    </Badge>
                    {item.url ? (
                      <a
                        className={styles.runLink}
                        href={item.url}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {item.key}
                      </a>
                    ) : (
                      <Typography variant="mono" color="subtle" as="span">
                        {item.key}
                      </Typography>
                    )}
                    <Typography variant="body-sm" as="span">
                      {item.title ?? ''}
                    </Typography>
                    <Typography variant="caption" color="subtle" as="span">
                      {t('tests.release.requirementCounts', {
                        cases: item.cases,
                        passed: item.passed,
                        failed: item.failed,
                        untested: item.untested,
                      })}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            )}

            {/* Трекер недоступен — это половина ответа, а не ошибка: вердикт
                считается по прогонам и без единой интеграции. */}
            {doc.warning && (
              <Typography variant="caption" color="subtle">
                {serverFieldText(doc, 'warning')}
              </Typography>
            )}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
