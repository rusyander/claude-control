import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { SkeletonList } from '@shared/ui/skeleton';
import { useClaudeMd, useUpdateClaudeMd } from '@entities/AppConfig';
import { instructionsView } from './model/instructionsView';
import styles from './ClaudeMdPage.module.scss';

/**
 * Глобальные инструкции целиком — универсальный по активному провайдеру раздел.
 * У Claude это CLAUDE.md, у Codex — AGENTS.md, у Gemini — GEMINI.md; заголовок,
 * подпись и пояснение подстраиваются под файл и провайдера. Раздел «Правила»
 * разбирает файл на карточки, а здесь он открыт как есть: посмотреть, что вообще
 * в нём лежит, и поправить руками. Перед записью сервер делает резервную копию.
 * Для Claude вид и тексты остаются как раньше (регресс-ноль).
 */
export function ClaudeMdPage() {
  const { t } = useTranslation();
  const { data, isLoading } = useClaudeMd();
  const update = useUpdateClaudeMd();
  const [value, setValue] = useState<string | undefined>(undefined);

  // Подхватываем содержимое, как только оно загрузилось.
  useEffect(() => {
    if (data !== undefined && value === undefined) setValue(data.content);
  }, [data, value]);

  if (isLoading || value === undefined || data === undefined) {
    return <SkeletonList rows={6} withActions={false} />;
  }

  const view = instructionsView(data);
  const dirty = value !== data.content;

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t(view.title.key, view.title.params)}
        subtitle={t(view.subtitle.key, view.subtitle.params)}
        helpTopic="claudeMd"
      />

      <ExplainBox
        title={t('claudeMd.explainTitle')}
        text={t(view.explain.key, view.explain.params)}
      />

      {view.cliHint && (
        <Card padding="sm">
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Icon name="info" size={18} />
            <Typography variant="body-sm" color="muted">
              {t(view.cliHint.key, view.cliHint.params)}
            </Typography>
          </Stack>
        </Card>
      )}

      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <textarea
            className={styles.editor}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            spellCheck={false}
            aria-label={t(view.title.key, view.title.params)}
          />

          <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
            <Typography variant="caption" color="subtle">
              {t('claudeMd.chars', { count: value.length })}
              {dirty ? ` · ${t('claudeMd.unsaved')}` : ''}
            </Typography>

            <Stack direction="row" gap="var(--spacing-xs)">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setValue(data.content)}
                disabled={!dirty || update.isPending}
              >
                {t('claudeMd.revert')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Icon name="check" size={18} />}
                onClick={() => update.mutate(value)}
                isLoading={update.isPending}
                disabled={!dirty}
              >
                {t('common.save')}
              </Button>
            </Stack>
          </Stack>

          <Typography variant="caption" color="subtle">
            {t('common.needsRestart')}
          </Typography>
        </Stack>
      </Card>
    </Stack>
  );
}
