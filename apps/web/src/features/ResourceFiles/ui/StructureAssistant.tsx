import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { toErrorMessage } from '@shared/api/client';
import type { AssistTurn } from '@shared/lib/assistant-fields';
import {
  ImageAttachButton,
  ImageAttachTray,
  ImageAttachZone,
  useImageAttach,
} from '@shared/ui/image-attach';
import { useStructureAssistant, type StructureAssistReply } from '@entities/Resource';
import type { StructureAssistantProps } from './StructureAssistant.types';
import styles from './ResourceFileTree.module.scss';

/**
 * Помощник структуры. Заполняет не одно поле, а всё дерево: по описанию задачи
 * создаёт и дополняет файлы целиком. Продолжает разговор в рамках одного
 * ресурса — так можно дорабатывать структуру по шагам, а не с чистого листа.
 * Сессии у помощника нет (лёгкое окно, D4 28.09): прежние реплики едут в запросе.
 */
export function StructureAssistant({ kind, id }: StructureAssistantProps) {
  const { t } = useTranslation();
  const assist = useStructureAssistant(kind, id);
  const [prompt, setPrompt] = useState('');
  const [history, setHistory] = useState<AssistTurn[]>([]);
  const [last, setLast] = useState<StructureAssistReply | undefined>(undefined);
  // Снимок или схема рядом с описанием: «собери скилл, как на схеме».
  const attach = useImageAttach({ disabled: assist.isPending });

  const run = (): void => {
    if (!prompt.trim() || attach.isPreparing) return;

    const images = attach.images;
    assist.mutate(
      { prompt, history, ...(images.length > 0 ? { images } : {}) },
      {
        onSuccess: (data) => {
          setLast(data);
          setHistory((turns) => [
            ...turns,
            { role: 'user', text: prompt },
            ...(data.reply.trim() ? [{ role: 'assistant' as const, text: data.reply }] : []),
          ]);
          setPrompt('');
          attach.clear();
        },
      },
    );
  };

  return (
    <div className={styles.assistant} data-structure-assistant>
      <Stack direction="row" align="center" gap="var(--spacing-2xs)">
        <Icon name="mic" size={16} />
        <Typography variant="body-sm" weight="medium" as="span">
          {t('resources.assistantTitle')}
        </Typography>
      </Stack>

      <Typography variant="caption" color="subtle">
        {t('resources.assistantHint')}
      </Typography>

      <ImageAttachTray attach={attach} />
      <ImageAttachZone attach={attach}>
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
      </ImageAttachZone>

      <Stack direction="row" align="center" gap="var(--spacing-xs)">
        <ImageAttachButton attach={attach} size="sm" />
        <Button
          size="sm"
          variant="primary"
          leftIcon={<Icon name="send" size={16} />}
          onClick={run}
          disabled={!prompt.trim() || attach.isPreparing}
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

      {/* Причина сервера словами (картинок больше восьми, не тот тип): общий
          «не сохранилось» не говорил, что поправить. */}
      {assist.isError && (
        <Typography variant="caption" color="danger" role="alert">
          {toErrorMessage(assist.error) || t('errors.saveFailed')}
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

          {/* Секрет помощнику не показывается: файл, где маска не легла на место,
              сервер не пишет — иначе человек не узнал бы, почему файла нет. */}
          {last.kept && last.kept.length > 0 && (
            <Typography variant="caption" color="warning" data-structure-kept>
              {t('resources.assistantKeptSecrets', { files: last.kept.join(', ') })}
            </Typography>
          )}
        </Stack>
      )}
    </div>
  );
}
