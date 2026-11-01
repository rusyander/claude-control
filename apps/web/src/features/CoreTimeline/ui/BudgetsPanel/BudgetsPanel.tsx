import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { formatClock, formatCount, formatUsd } from '../../model/format';
import { tokenTotal } from '../../model/items';
import type { BudgetsPanelProps } from './BudgetsPanel.types';

const VERDICT_TONE = {
  open: 'success',
  warn: 'warning',
  refused: 'danger',
  held: 'warning',
  exhausted: 'danger',
  offline: 'neutral',
} as const;

/**
 * Расход и лимиты задачи вживую (07:21): токены, деньги и единицы окна — из `spend` вида ядра
 * (`spendOf`, P43), бюджеты и окна — последние `budget.state` / `window.state`. Вид перечитывается
 * на каждую пачку строк потока, поэтому числа идут вместе с лентой, а не по F5.
 */
export function BudgetsPanel({ view }: BudgetsPanelProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { tokens, cost } = view.spend;
  const total = tokenTotal(tokens);
  return (
    <Card padding="md" data-core-budgets>
      <Stack gap="var(--spacing-xs)">
        <Typography variant="heading-sm" as="h2">
          {t('coreTimeline.budgets.title')}
        </Typography>
        <Stack direction="row" gap="var(--spacing-lg)" wrap>
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="caption" color="muted">
              {t('coreTimeline.budgets.tokens')}
            </Typography>
            <Typography
              variant="body"
              weight="medium"
              data-core-tokens={total}
              title={t('coreTimeline.budgets.tokensHint', {
                input: formatCount(tokens.input, lang),
                cacheRead: formatCount(tokens.cacheRead, lang),
                cacheWrite: formatCount(tokens.cacheWrite, lang),
                output: formatCount(tokens.output, lang),
              })}
            >
              {formatCount(total, lang)}
            </Typography>
            <Typography variant="caption" color="subtle">
              {t('coreTimeline.budgets.turns', { count: tokens.turns })}
            </Typography>
          </Stack>
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="caption" color="muted">
              {t('coreTimeline.budgets.cost')}
            </Typography>
            <Typography variant="body" weight="medium" data-core-usd={cost.usd}>
              {t('coreTimeline.budgets.costValue', { usd: formatUsd(cost.usd) })}
            </Typography>
            {cost.unpricedTokens > 0 && (
              <Typography variant="caption" color="warning" data-core-unpriced>
                {t('coreTimeline.budgets.unpriced', {
                  count: formatCount(cost.unpricedTokens, lang),
                })}
              </Typography>
            )}
            {cost.windowUnits > 0 && (
              <Typography variant="caption" color="subtle">
                {t('coreTimeline.budgets.windowUnits', { units: cost.windowUnits })}
              </Typography>
            )}
          </Stack>
        </Stack>
        {view.budgets.map((b) => (
          <Stack
            key={b.scope}
            direction="row"
            gap="var(--spacing-xs)"
            align="center"
            data-core-budget={b.scope}
          >
            <Typography variant="body-sm" as="span">
              {t('coreTimeline.budgets.budget', { scope: b.scope })}
            </Typography>
            <Typography variant="body-sm" color="muted" as="span">
              {b.limit === null
                ? t('coreTimeline.budgets.budgetUnlimited', { spent: formatCount(b.spent, lang) })
                : t('coreTimeline.budgets.budgetValue', {
                    spent: formatCount(b.spent, lang),
                    limit: formatCount(b.limit, lang),
                  })}
            </Typography>
          </Stack>
        ))}
        {view.windows.length > 0 && (
          <Typography variant="caption" color="muted">
            {t('coreTimeline.budgets.windows')}
          </Typography>
        )}
        {view.windows.map((w) => (
          <Stack
            key={`${w.routeId}:${w.limitKind}`}
            direction="row"
            gap="var(--spacing-xs)"
            align="center"
            wrap
            data-core-window={w.routeId}
            data-window-verdict={w.verdict}
          >
            <Typography variant="body-sm" as="span">
              {t('coreTimeline.budgets.window', {
                route: w.routeId,
                kind: t(`coreTimeline.budgets.limitKind.${w.limitKind}`),
              })}
            </Typography>
            <Badge tone={VERDICT_TONE[w.verdict]}>
              {t(`coreTimeline.budgets.verdict.${w.verdict}`)}
            </Badge>
            {w.resetAt !== null && (
              <Typography variant="caption" color="subtle" as="span">
                {t('coreTimeline.budgets.resetAt', { time: formatClock(w.resetAt, lang) })}
              </Typography>
            )}
          </Stack>
        ))}
        {view.budgets.length === 0 && view.windows.length === 0 && (
          <Typography variant="caption" color="subtle">
            {t('coreTimeline.budgets.none')}
          </Typography>
        )}
      </Stack>
    </Card>
  );
}
