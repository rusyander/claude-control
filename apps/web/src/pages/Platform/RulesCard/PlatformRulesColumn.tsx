import { useTranslation } from 'react-i18next';
import type { Platform, PlatformRuleRow } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import styles from '../PlatformPage.module.scss';
import { managedRules, observedRules } from '../lib/rulesView';
import { ManagedRuleField } from './ManagedRuleField';
import type { RuleDrafts } from './useRuleDrafts';
import { serverFieldText } from '@shared/config/i18n';

interface PlatformRulesColumnProps {
  platform: Platform;
  rules: PlatformRuleRow[];
  drafts: RuleDrafts;
  toolsLocked: boolean;
  update: (next: Platform) => void;
}

/**
 * Левая колонка — правила ПЛАТФОРМЫ: сверху то, чем панель распоряжается
 * (поля запроса, которые контур принимает), снизу то, что контур делает сам и
 * чего отсюда не отменить. Человек, не нашедший галочки, должен прочитать
 * «включает владелец контура», а не решить, что панель сломалась.
 */
export function PlatformRulesColumn({
  platform,
  rules,
  drafts,
  toolsLocked,
  update,
}: PlatformRulesColumnProps) {
  const { t } = useTranslation();
  const managed = managedRules(rules);
  const observed = observedRules(rules);

  return (
    <section
      className={`${styles.rulesColumn} ${styles.rulesColumnPlatform}`}
      aria-labelledby={`rules-platform-${platform.id}`}
      data-rules-side="platform"
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
              <ManagedRuleField
                key={row.id}
                row={row}
                platform={platform}
                drafts={drafts}
                toolsLocked={toolsLocked}
                update={update}
              />
            ))}
          </Stack>
        )}
        {observed.length > 0 && (
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm" weight="medium">
              {t('platform.rulesObserved')}
            </Typography>
            {observed.map((row) => (
              <Stack key={row.id} gap="var(--spacing-3xs)">
                <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
                  <Typography variant="body-sm" as="span">
                    {serverFieldText(row, 'title')}
                  </Typography>
                  <Badge tone="neutral">{serverFieldText(row, 'where')}</Badge>
                </Stack>
                <Typography variant="caption" color="muted" as="span">
                  {serverFieldText(row, 'detail')}
                </Typography>
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    </section>
  );
}
