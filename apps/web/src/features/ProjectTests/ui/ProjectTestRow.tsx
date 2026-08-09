import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectTestStatus } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import type { ProjectTestRowProps } from './ProjectTestRow.types';
import styles from './ProjectTests.module.scss';

/**
 * Один кейс списком.
 *
 * Свёрнут по умолчанию: у набора в несколько сотен кейсов шаги каждого — это
 * простыня, в которой не найти провалившийся. Развёрнутым он показывает то,
 * ради чего его открывают: шаги, ожидание и что агент увидел на самом деле.
 *
 * Провалившийся кейс обведён рамкой и без раскрытия — по списку должно быть
 * видно, куда смотреть, ещё до чтения подписей.
 */
const TONE: Record<ProjectTestStatus, 'success' | 'danger' | 'warning' | 'info' | 'neutral'> = {
  passed: 'success',
  failed: 'danger',
  skipped: 'warning',
  running: 'info',
  unknown: 'neutral',
};

export function ProjectTestRow({
  testCase,
  isChecked,
  onCheck,
  onEdit,
  onRemove,
}: ProjectTestRowProps) {
  const { t } = useTranslation();
  const [isOpen, setOpen] = useState(false);

  const rowStyle = [
    styles.row,
    testCase.status === 'failed' ? styles.rowFailed : '',
    testCase.status === 'running' ? styles.rowRunning : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rowStyle}>
      <input
        type="checkbox"
        className={styles.checkbox}
        checked={isChecked}
        onChange={onCheck}
        aria-label={testCase.title}
      />

      <div className={styles.rowText}>
        {/* Раскрытие висит на заголовке, а не на всей строке: внутри
            развёрнутого кейса есть свой текст, который нужно выделять мышью. */}
        <button
          type="button"
          className={styles.head}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={isOpen}
        >
          <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
            <Badge tone={TONE[testCase.status]}>
              {t(`projectTests.status.${testCase.status}`)}
            </Badge>
            <Typography variant="body" weight="medium">
              {testCase.title}
            </Typography>
            {testCase.area && <Badge tone="neutral">{testCase.area}</Badge>}
          </Stack>
        </button>

        {testCase.purpose && (
          <Typography variant="caption" color="subtle">
            {testCase.purpose}
          </Typography>
        )}

        {isOpen && (
          <>
            {testCase.steps.length > 0 && (
              <ol className={styles.steps}>
                {testCase.steps.map((step, index) => (
                  <li key={index}>
                    <Typography variant="caption" as="span">
                      {step}
                    </Typography>
                  </li>
                ))}
              </ol>
            )}
            {testCase.expected && (
              <Typography variant="caption" color="subtle">
                → {testCase.expected}
              </Typography>
            )}
            {/* Что агент увидел на самом деле — единственное, ради чего вообще
                открывают провалившийся кейс. */}
            {testCase.note && (
              <Typography
                variant="caption"
                color={testCase.status === 'failed' ? 'danger' : 'subtle'}
              >
                {testCase.note}
              </Typography>
            )}
            <div className={styles.meta}>
              <Typography variant="caption" color="subtle" as="span">
                {testCase.id} · {t(`projectTests.bySource.${testCase.source}`)}
              </Typography>
              {testCase.lastRunAt && (
                <Typography variant="caption" color="subtle" as="span">
                  {t('projectTests.lastRun', {
                    time: new Date(testCase.lastRunAt).toLocaleString(),
                  })}
                </Typography>
              )}
            </div>
          </>
        )}
      </div>

      <div className={styles.actions}>
        <Button
          variant="ghost"
          iconOnly
          icon={<Icon name="edit" size={18} />}
          aria-label={t('projectTests.editCase')}
          onClick={onEdit}
        />
        <Button
          variant="ghost"
          iconOnly
          icon={<Icon name="trash" size={18} />}
          aria-label={t('projectTests.removeCase')}
          onClick={onRemove}
        />
      </div>
    </div>
  );
}
