import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { PlatformConsumerOption, PlatformStatus } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { overlapSummary } from './lib/contourConfigView';
import { ContourSections } from './ContourSections';
import { RulesChoice } from './RulesChoice';

interface ContourConfigProps {
  status: PlatformStatus;
  options: readonly PlatformConsumerOption[] | undefined;
  filesApplied: boolean;
}

/**
 * Конфигурация контура на его карточке (баг 11): какие разделы через него
 * ходят и чьи правила действуют. Обе вещи и раньше существовали — на вкладках
 * «Доступ разделов» и «Правила», — но с карточки, где человек смотрит на
 * контур, их было не видно, и владелец раздела решил, что их нет.
 *
 * Правила здесь — выбор и сводка пересечений; сами колонки и матрица остаются
 * на вкладке правил, куда ведёт кнопка.
 */
export function ContourConfig({ status, options, filesApplied }: ContourConfigProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const summary = overlapSummary(status.conflicts);

  const openRules = (): void => {
    void navigate({
      to: '/platform',
      search: { tab: 'rules', id: status.platform.id },
      replace: true,
    } as never);
  };

  return (
    <Stack gap="var(--spacing-md)">
      <ContourSections status={status} options={options} filesApplied={filesApplied} />

      <Stack gap="var(--spacing-2xs)" data-contour-rules={status.platform.id}>
        <RulesChoice platform={status.platform} withTitle />
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="caption" color="muted" as="span" data-overlap-total={summary.total}>
            {summary.total > 0
              ? t('contourConfig.rules.overlaps', { count: summary.total })
              : t('contourConfig.rules.noOverlaps')}
            {summary.active > 0 &&
              ` · ${t('contourConfig.rules.overlapsActive', { count: summary.active })}`}
          </Typography>
          <Button variant="ghost" size="sm" onClick={openRules}>
            {t('contourConfig.rules.openRules')}
          </Button>
        </Stack>
      </Stack>
    </Stack>
  );
}
