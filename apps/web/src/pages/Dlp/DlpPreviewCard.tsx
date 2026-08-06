import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DlpPreviewResult, DlpRule } from '@claude-control/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge, type BadgeTone } from '@shared/ui/badge';
import { TextField } from '@shared/ui/text-field';
import { useDlpPreview } from '@entities/Dlp';

interface Props {
  rules: DlpRule[];
}

/** Итог проверки одной строкой: отклонён, с заменами или чисто. */
function verdictOf(result: DlpPreviewResult): { tone: BadgeTone; key: string } {
  if (result.blocked) return { tone: 'danger', key: 'dlp.previewBlocked' };
  if (result.hits.length > 0) return { tone: 'warning', key: 'dlp.previewMasked' };
  return { tone: 'success', key: 'dlp.previewClean' };
}

/**
 * Проверка правил на пробном тексте: показать ровно то, что увидела бы модель.
 *
 * Работает по ЧЕРНОВИКУ правил, до сохранения, и никуда не ходит по сети —
 * иначе единственным способом узнать, что делает правило, оставался бы боевой
 * запрос, а ошибку в правиле замечали бы уже после утечки.
 */
export function DlpPreviewCard({ rules }: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [result, setResult] = useState<DlpPreviewResult | undefined>(undefined);
  const preview = useDlpPreview();

  const run = (): void => {
    preview.mutate({ text, rules }, { onSuccess: setResult });
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="body" weight="medium">
          {t('dlp.previewTitle')}
        </Typography>
        <Typography variant="body-sm" color="subtle" style={{ maxWidth: 'var(--text-measure)' }}>
          {t('dlp.previewHint')}
        </Typography>

        <TextField
          label={t('dlp.previewInput')}
          value={text}
          onChange={setText}
          placeholder={t('dlp.previewPlaceholder')}
          multiline
          rows={4}
        />

        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Icon name="eye" size={16} />}
            onClick={run}
            disabled={!text.trim()}
            isLoading={preview.isPending}
          >
            {t('dlp.previewRun')}
          </Button>
          {result && (
            <Badge tone={verdictOf(result).tone}>
              {t(verdictOf(result).key, { count: result.hits.length })}
            </Badge>
          )}
        </Stack>

        {result && !result.blocked && (
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm" color="subtle">
              {t('dlp.previewResult')}
            </Typography>
            <Typography variant="mono" as="pre" style={{ whiteSpace: 'pre-wrap' }}>
              {result.masked}
            </Typography>
          </Stack>
        )}

        {result?.hits.map((hit) => (
          <Typography key={`${hit.ruleId}-${hit.placeholder}`} variant="caption" color="subtle">
            {t('dlp.previewHit', {
              rule: hit.ruleName,
              placeholder: hit.placeholder || t(`dlp.action.${hit.action}`),
              count: hit.count,
            })}
          </Typography>
        ))}
      </Stack>
    </Card>
  );
}
