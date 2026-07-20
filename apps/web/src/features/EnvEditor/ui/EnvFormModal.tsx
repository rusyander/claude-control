import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { EnvSource } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { Stack } from '@shared/ui/stack';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { Typography } from '@shared/ui/typography';
import { FormWithAssistant } from '@shared/ui/form-with-assistant';
import { Badge } from '@shared/ui/badge';
import { BulkCreate } from '@shared/ui/bulk-create';
import type { EnvFormModalProps } from './EnvFormModal.types';
import styles from './EnvFormModal.module.scss';

/**
 * Создание и правка переменной окружения. Источник выбирается явно: settings.json
 * видит сам Claude Code, а .mcp-secrets.env читает лаунчер MCP-серверов —
 * от этого зависит, куда попадёт значение.
 */
export function EnvFormModal({ isOpen, onOpenChange, envVar }: EnvFormModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [source, setSource] = useState<EnvSource>('secrets');
  const [comment, setComment] = useState('');
  // Одна переменная или список сразу — полезно вставить целый .env.
  const [isBulk, setIsBulk] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setKey(envVar?.key ?? '');
    // Значение секрета приходит замаскированным — при правке его нужно ввести
    // заново, иначе в файл уедет строка с точками.
    setValue(envVar && !envVar.isSecret ? envVar.value : '');
    setSource(envVar?.source ?? 'secrets');
    setComment(envVar?.comment ?? '');
    setIsBulk(false);
  }, [isOpen, envVar]);

  /** Похоже ли имя на секрет — по нему решаем, куда класть и маскировать ли. */
  const looksSecret = (name: string): boolean => /(TOKEN|SECRET|KEY|PASSWORD|PAT)/i.test(name);

  const save = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post('/env', {
        key: key.trim(),
        value,
        source,
        isSecret: /(TOKEN|SECRET|KEY|PASSWORD|PAT)/i.test(key),
        comment: comment.trim() || undefined,
      });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.env });
      onOpenChange(false);
    },
  });

  const canSave = key.trim().length > 0 && !save.isPending;

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={envVar ? `${t('common.edit')}: ${envVar.key}` : t('env.addVar')}
      description={t('common.needsRestart')}
      size="xl"
      footer={
        isBulk ? (
          <Button onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              onClick={() => save.mutate()}
              disabled={!canSave}
              isLoading={save.isPending}
            >
              {t('common.save')}
            </Button>
          </>
        )
      }
    >
      {!envVar && (
        <Stack direction="row" gap="var(--spacing-3xs)" className={styles.modeTabs}>
          <Button
            size="sm"
            variant={!isBulk ? 'primary' : 'ghost'}
            onClick={() => setIsBulk(false)}
          >
            {t('bulk.modeSingle')}
          </Button>
          <Button size="sm" variant={isBulk ? 'primary' : 'ghost'} onClick={() => setIsBulk(true)}>
            {t('bulk.modeMany')}
          </Button>
        </Stack>
      )}

      {isBulk ? (
        <BulkCreate
          kindLabel={t('env.title')}
          placeholder={'NODE_ENV=production\nAPI_URL=https://example.com\nGITLAB_TOKEN=...'}
          parseLine={(line) => {
            // Строка формата KEY=value — как в .env-файле.
            const eq = line.indexOf('=');
            if (eq <= 0) return { raw: line, error: t('bulk.needEquals') };

            const name = line.slice(0, eq).trim();
            const val = line.slice(eq + 1).trim();
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
              return { raw: line, error: t('bulk.badKey') };
            }

            // Секреты кладём в файл токенов и маскируем — как в одиночной форме.
            const isSecret = looksSecret(name);
            return {
              raw: line,
              draft: {
                key: name,
                value: val,
                source: (isSecret ? 'secrets' : 'settings') as EnvSource,
                isSecret,
              },
            };
          }}
          createOne={(draft) => apiClient.post('/env', draft)}
          renderPreview={(draft) => (
            <Stack direction="row" align="center" gap="var(--spacing-xs)">
              <Badge tone={draft.isSecret ? 'warning' : 'neutral'}>{draft.source}</Badge>
              <Typography variant="mono" as="span">
                {draft.key}
                {draft.isSecret ? ' = ••••' : ` = ${draft.value}`}
              </Typography>
            </Stack>
          )}
          onDone={() => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.env });
            onOpenChange(false);
          }}
        />
      ) : (
        <FormWithAssistant
          kind={t('env.title')}
          fields={{ key, value, source, comment }}
          schema={{
            key: 'Имя переменной заглавными буквами через подчёркивание',
            value: 'Значение переменной',
            source: 'Куда сохранить: settings (видит Claude Code) или secrets (файл токенов)',
            comment: 'Комментарий: откуда взять значение или зачем оно',
          }}
          onApply={(applied) => {
            if (typeof applied.key === 'string') setKey(applied.key);
            if (typeof applied.value === 'string') setValue(applied.value);
            if (applied.source === 'settings' || applied.source === 'secrets') {
              setSource(applied.source);
            }
            if (typeof applied.comment === 'string') setComment(applied.comment);
          }}
        >
          <Stack gap="var(--spacing-md)">
            <TextField
              label={t('env.varKey')}
              value={key}
              onChange={setKey}
              placeholder="MY_TOKEN"
              isMono
              autoFocus={!envVar}
            />

            <TextField
              label={t('env.varValue')}
              value={value}
              onChange={setValue}
              placeholder={envVar?.isSecret ? t('env.secretHidden') : ''}
              hint={envVar?.isSecret ? t('env.secretRewrite') : undefined}
              isMono
            />

            <SelectField
              label={t('env.source')}
              value={source}
              onChange={(next) => setSource(next as EnvSource)}
              options={[
                { value: 'secrets', label: '.mcp-secrets.env' },
                { value: 'settings', label: 'settings.json' },
              ]}
              hint={t('env.explain')}
            />

            <TextField
              label={t('env.varComment')}
              value={comment}
              onChange={setComment}
              placeholder={t('env.varCommentPlaceholder')}
            />

            {save.isError && (
              <Typography variant="body-sm" color="danger">
                {t('errors.saveFailed')}
              </Typography>
            )}
          </Stack>
        </FormWithAssistant>
      )}
    </Modal>
  );
}
