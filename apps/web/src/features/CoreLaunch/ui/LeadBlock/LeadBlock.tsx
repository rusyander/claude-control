import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { LeadSettingsCard, type LeadSettingsCardProps } from '../LeadSettingsCard/LeadSettingsCard';
import { McpPicksCard } from '../McpPicksCard/McpPicksCard';

/**
 * Блок «Ведение задачи» (этап 11, W3-16): как ядро ведёт задачи — настройки ведения и серверы MCP,
 * которые получают шаги, рядом: обе — настройка ядра, обе пишутся `set-config` с отпечатком.
 */
export function LeadBlock(props: LeadSettingsCardProps) {
  const { t } = useTranslation();
  const P = 'coreLaunch.leadBlock';
  return (
    <section aria-labelledby="lead-block-heading" data-lead-block>
      <Stack gap="var(--spacing-sm)">
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="heading-sm" as="h2" id="lead-block-heading">
            {t(`${P}.heading`)}
          </Typography>
          <Typography variant="caption" color="muted" as="p">
            {t(`${P}.hint`)}
          </Typography>
        </Stack>
        <LeadSettingsCard {...props} />
        <McpPicksCard />
      </Stack>
    </section>
  );
}
