import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { formatCount, formatUsd } from '../../model/format';
import { tokenTotal } from '../../model/items';
import type { SessionLineProps } from './SessionLine.types';

/**
 * Сессия строкой (07:20, R:PR-10): CLI с версией, модель как просили и как ответил маршрут,
 * усилие, маршрут и расход сессии по `spendOf` ядра. Модель «по умолчанию CLI» названа прямо —
 * пустое место читалось бы как «модель неизвестна».
 */
export function SessionLine({ session, spend }: SessionLineProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const cli = session.cliVersion ? `${session.cli} ${session.cliVersion}` : session.cli;
  return (
    <Stack
      direction="row"
      gap="var(--spacing-xs)"
      wrap
      align="center"
      data-core-session={session.sessionId}
    >
      <Typography variant="body-sm" weight="medium" as="span">
        {t('coreTimeline.timeline.session', { cli })}
      </Typography>
      <Typography variant="caption" color="muted" as="span" data-session-model>
        {session.modelAsked
          ? t('coreTimeline.timeline.sessionModel', { model: session.modelAsked })
          : t('coreTimeline.timeline.sessionModelDefault')}
        {session.modelServed && session.modelServed !== session.modelAsked
          ? ` · ${t('coreTimeline.timeline.sessionServed', { model: session.modelServed })}`
          : ''}
      </Typography>
      {session.effort && (
        <Typography variant="caption" color="muted" as="span" data-session-effort>
          {t('coreTimeline.timeline.sessionEffort', { effort: session.effort })}
        </Typography>
      )}
      <Typography variant="caption" color="muted" as="span" data-session-route={session.route.id}>
        {t('coreTimeline.timeline.sessionRoute', { route: session.route.id })}
      </Typography>
      <Badge tone="neutral">{session.state}</Badge>
      {spend && (
        <Typography variant="caption" as="span" data-session-tokens={tokenTotal(spend.tokens)}>
          {t('coreTimeline.timeline.tokens', {
            tokens: formatCount(tokenTotal(spend.tokens), lang),
          })}
          {' · '}
          {t('coreTimeline.timeline.cost', { usd: formatUsd(spend.cost.usd) })}
        </Typography>
      )}
    </Stack>
  );
}
