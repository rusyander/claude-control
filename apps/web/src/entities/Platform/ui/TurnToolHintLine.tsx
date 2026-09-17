import { useTranslation } from 'react-i18next';
import { PLATFORM_AGENT_VERIFIED_FROM_B } from '@agentdeck/contracts/platform-tool-hint';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { StatusDot } from '@shared/ui/status-dot';
import type { TurnToolHint } from '../model/turnToolHint';

interface TurnToolHintLineProps {
  hint: TurnToolHint;
}

/**
 * Строка под последним ходом агента через контур. Одна на оба чата — Claude и
 * чужого CLI, — чтобы одна и та же ситуация не называлась двумя разными словами.
 *
 * Предупреждение, а не ошибка: ноль вызовов законен для хода-вопроса, и строка
 * говорит «если вы ждали правок», а не «сломалось».
 */
export function TurnToolHintLine({ hint }: TurnToolHintLineProps) {
  const { t } = useTranslation();
  return (
    <Stack direction="row" gap="var(--spacing-2xs)" align="center" role="status">
      <StatusDot tone="warning" />
      <Typography variant="caption" color="muted">
        {hint === 'call-as-text'
          ? t('platform.turnCallAsText')
          : t('platform.turnNoTools', { size: PLATFORM_AGENT_VERIFIED_FROM_B })}
      </Typography>
    </Stack>
  );
}
