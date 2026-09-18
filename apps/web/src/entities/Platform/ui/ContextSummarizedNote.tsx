import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { StatusDot } from '@shared/ui/status-dot';

interface ContextSummarizedNoteProps {
  /**
   * Чем узнан ответ. `answer` — ответ Claude: шлюз выдал ему id сообщения, и
   * сжатие было именно в запросе этого ответа. `run` — ответ чужого CLI: весь
   * прогон один ответ, и сжатие было в одном из запросов этого прогона.
   */
  scope: 'answer' | 'run';
}

/**
 * Подпись «контур сжал историю» под ответом (`context-managed`). Одна на оба
 * чата — Claude и чужого CLI, — чтобы одно событие не называлось двумя словами.
 *
 * Без неё человек читает ответ как ответ модели, видевшей весь разговор, и ищет
 * поломку там, где модель «забыла» начало: её просто не показали.
 */
export function ContextSummarizedNote({ scope }: ContextSummarizedNoteProps) {
  const { t } = useTranslation();
  return (
    <Stack direction="row" gap="var(--spacing-2xs)" align="center" data-context-summarized={scope}>
      <StatusDot tone="warning" />
      <Typography variant="caption" color="muted">
        {scope === 'answer' ? t('platform.summarizedAnswer') : t('platform.summarizedRun')}
      </Typography>
    </Stack>
  );
}
