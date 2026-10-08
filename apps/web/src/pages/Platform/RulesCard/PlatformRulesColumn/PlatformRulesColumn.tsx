import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlatformRuleConflict } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import styles from './PlatformRulesColumn.module.scss';
import { ManagedRuleField } from '../ManagedRuleField/ManagedRuleField';
import { OverlapMark } from '../OverlapMark/OverlapMark';
import { SideOffNote } from '../SideOffNote/SideOffNote';
import { serverFieldText } from '@shared/config/i18n';
import type { PlatformRulesColumnProps } from './PlatformRulesColumn.types';
import { overlapsByPlatformRule } from '../../lib/overlapsByPlatformRule';
import { ourOverlapName } from '../../lib/ourOverlapName';
import { managedRules } from '../../lib/managedRules';
import { observedRules } from '../../lib/observedRules';

/**
 * Левая колонка — правила ПЛАТФОРМЫ: сверху то, чем панель распоряжается
 * (поля запроса, которые контур принимает), снизу то, что контур делает сам и
 * чего отсюда не отменить. Человек, не нашедший галочки, должен прочитать
 * «включает владелец контура», а не решить, что панель сломалась.
 *
 * Строка, которая задевает наше правило, несёт отметку пересечения прямо под
 * собой (баг 11в), а снятая выбором колонка — пунктир и надпись (баг 11б).
 */
export function PlatformRulesColumn({
  platform,
  rules,
  drafts,
  toolsLocked,
  update,
  conflicts,
  offBy,
}: PlatformRulesColumnProps) {
  const { t } = useTranslation();
  const managed = managedRules(rules);
  const observed = observedRules(rules);
  const overlaps = overlapsByPlatformRule(conflicts);

  /** Наша сторона пересечения словами; незнакомую называет заголовок ячейки. */
  const oursName = (cell: PlatformRuleConflict): string => {
    const name = ourOverlapName(cell.ourRule);
    return name ? t(`contourConfig.overlap.ours.${name}`) : serverFieldText(cell, 'title');
  };
  const mark = (id: string): ReactNode => {
    const cell = overlaps.get(id);
    return cell ? <OverlapMark cell={cell} what={oursName(cell)} /> : null;
  };

  return (
    <section
      className={`${styles.rulesColumn} ${styles.rulesColumnPlatform} ${offBy ? styles.rulesColumnOff : ''}`}
      aria-labelledby={`rules-platform-${platform.id}`}
      data-rules-side="platform"
      data-side-off={offBy ? 'true' : 'false'}
    >
      <Stack gap="var(--spacing-sm)">
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body" weight="medium" as="h3" id={`rules-platform-${platform.id}`}>
            {t('platform.rulesSidePlatform')}
          </Typography>
          <Typography variant="caption" color="muted">
            {t('platform.rulesSidePlatformText')}
          </Typography>
        </Stack>
        <SideOffNote offBy={offBy} />
        {/* Драйвер, не объявивший о себе ничего (любой совместимый шлюз), даёт
          пустой список — и это «неизвестно», а не «ничего не делает». */}
        {rules.length === 0 && (
          <Typography variant="body-sm" color="muted">
            {t('platform.rulesEmpty')}
          </Typography>
        )}

        {managed.length > 0 && (
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm" weight="medium">
              {t('platform.rulesManaged')}
            </Typography>
            {managed.map((row) => (
              <Stack key={row.id} gap="var(--spacing-3xs)" data-rule-row={row.id}>
                <ManagedRuleField
                  row={row}
                  platform={platform}
                  drafts={drafts}
                  toolsLocked={toolsLocked}
                  update={update}
                />
                {mark(row.id)}
              </Stack>
            ))}
          </Stack>
        )}
        {observed.length > 0 && (
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm" weight="medium">
              {t('platform.rulesObserved')}
            </Typography>
            {observed.map((row) => (
              <Stack key={row.id} gap="var(--spacing-3xs)" data-rule-row={row.id}>
                <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
                  <Typography variant="body-sm" as="span">
                    {serverFieldText(row, 'title')}
                  </Typography>
                  <Badge tone="neutral">{serverFieldText(row, 'where')}</Badge>
                </Stack>
                <Typography variant="caption" color="muted" as="span">
                  {serverFieldText(row, 'detail')}
                </Typography>
                {mark(row.id)}
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    </section>
  );
}
