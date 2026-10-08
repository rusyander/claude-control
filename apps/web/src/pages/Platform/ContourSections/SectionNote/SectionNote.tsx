import type { SectionNoteProps } from './SectionNote.types';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';

/** Подпись под закрытыми ассистентом и терминалом: как их открыть и куда идти. */
export function SectionNote({ row, filesApplied, onOpenAccess }: SectionNoteProps) {
  const { t } = useTranslation();
  if (row.open || row.opensHere) return null;
  return (
    <Stack gap="var(--spacing-3xs)" align="start">
      <Typography variant="caption" color="muted" as="span">
        {row.kind === 'assistant'
          ? t('contourConfig.sections.assistantOpens')
          : t('contourConfig.sections.terminalOpens')}
      </Typography>
      {row.kind === 'terminal' && filesApplied && (
        <Typography variant="caption" color="warning" as="span">
          {t('contourConfig.sections.terminalClosedFiles')}
        </Typography>
      )}
      <Button variant="ghost" size="sm" onClick={onOpenAccess}>
        {t('contourConfig.sections.openAccess')}
      </Button>
    </Stack>
  );
}
