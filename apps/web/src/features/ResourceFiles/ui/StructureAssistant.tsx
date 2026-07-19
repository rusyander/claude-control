import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import {
  useStructureAssistant,
  type ResourceKind,
  type StructureAssistReply,
} from '@entities/Resource/api/ResourceApi';
import styles from './ResourceFileTree.module.scss';

interface StructureAssistantProps {
  kind: ResourceKind;
  id: string;
}

/**
 * Помощник структуры. Заполняет не одно поле, а всё дерево: по описанию задачи
 * создаёт и дополняет файлы целиком. Продолжает разговор в рамках одного
 * ресурса — так можно дорабатывать структуру по шагам, а не с чистого листа.
 */
export function StructureAssistant({ kind, id }: StructureAssistantProps) {
  const { t } = useTranslation();
  const assist = useStructureAssistant(kind, id);
  const [prompt, setPrompt] = useState('');
  const [session, setSession] = useState<string | undefined>(undefined);
  const [last, setLast] = useState<StructureAssistReply | undefined>(undefined);

  const run = (): void => {
    if (!prompt.trim()) return;

    assist.mutate(
      { prompt, sessionId: session },
      {
        onSuccess: (data) => {
          setLast(data);
          setSession(data.sessionId);
          setPrompt('');
        },
      },
    );
  };

  return (
    <div className={styles.assistant}>
      <Stack direction="row" align="center" gap="var(--spacing-2xs)">
        <Icon name="mic" size={16} />
        <Typography variant="body-sm" weight="medium" as="span">
          {t('resources.assistantTitle')}
        </Typography>
      </Stack>

      <Typography variant="caption" color="subtle">
        {t('resources.assistantHint')}
      </Typography>

      <textarea
        className={styles.assistantInput}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder={t('resources.assistantPlaceholder')}
        rows={2}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            run();
          }
        }}
      />

      <Stack direction="row" align="center" gap="var(--spacing-xs)">
        <Button
          size="sm"
          variant="primary"
          leftIcon={<Icon name="send" size={16} />}
          onClick={run}
          disabled={!prompt.trim()}
          isLoading={assist.isPending}
        >
          {t('resources.assistantRun')}
        </Button>

        {assist.isPending && (
          <Typography variant="caption" color="subtle">
            {t('resources.assistantWorking')}
          </Typography>
        )}
      </Stack>

      {assist.isError && (
        <Typography variant="caption" color="danger">
          {t('errors.saveFailed')}
        </Typography>
      )}

      {last && (
        <Stack gap="var(--spacing-2xs)" className={styles.assistantReply}>
          {last.reply && (
            <Typography variant="caption" color="muted">
              {last.reply}
            </Typography>
          )}

          {last.applied.length > 0 && (
            <Stack direction="row" gap="var(--spacing-3xs)" wrap>
              {last.applied.map((file) => (
                <Badge key={file} tone="success">
                  {file}
                </Badge>
              ))}
            </Stack>
          )}
        </Stack>
      )}
    </div>
  );
}
