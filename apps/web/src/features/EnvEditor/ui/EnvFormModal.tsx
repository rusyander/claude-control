import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { EnvSource, EnvVar } from '@claude-control/contracts';
import { ENV_KEY_PATTERN } from '@claude-control/contracts/env-secret';
import { apiClient, toErrorMessage } from '@shared/api/client';
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
import { buildEnvDraft, envFileName, looksSecret } from './EnvFormModal.lib';
import styles from './EnvFormModal.module.scss';

/**
 * Создание и правка переменной окружения. При создании файл выбирается явно:
 * settings.json видит сам Claude Code, а .mcp-secrets.env читает лаунчер
 * MCP-серверов — от этого зависит, куда попадёт значение. При правке файл
 * определяется записью и не меняется: иначе переменная тихо раздваивалась бы.
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
  // Отказ ДО запроса: имя не по правилу или такая переменная в этом файле уже есть.
  const [formError, setFormError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!isOpen) return;
    setKey(envVar?.key ?? '');
    // Значение секрета приходит замаскированным — при правке его нужно ввести
    // заново, иначе в файл уедет строка с точками.
    setValue(envVar && !envVar.isSecret ? envVar.value : '');
    setSource(envVar?.source ?? 'secrets');
    setComment(envVar?.comment ?? '');
    setIsBulk(false);
    setFormError(undefined);
  }, [isOpen, envVar]);

  const save = useMutation({
    mutationFn: async () => {
      const draft = await buildEnvDraft({ key, value, source, comment }, envVar);
      const { data } = await apiClient.post('/env', draft);
      // Переименование. Сервер знает только «записать KEY»: старая запись
      // осталась бы лежать рядом с новой. Убираем её сами — после того как новая
      // легла в файл, чтобы сбой не оставил переменную без обоих имён.
      if (envVar && envVar.key !== draft.key) {
        await apiClient.delete('/env', { params: { key: envVar.key, source: envVar.source } });
      }
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.env });
      onOpenChange(false);
    },
    // Причину отказа показываем в самой форме — общий тост её бы продублировал.
    meta: { successMessage: envVar ? 'toasts.saved' : 'toasts.created', silentError: true },
  });

  const submit = (): void => {
    const name = key.trim();
    if (!ENV_KEY_PATTERN.test(name)) {
      setFormError(t('env.badKey'));
      return;
    }
    // Дубль в том же файле: сервер молча перезаписал бы значение под видом
    // создания. Своя запись при правке (то же имя) дублем не считается. Ключ
    // группы (source group) физически лежит в settings.json — для него это дубль.
    const existing = queryClient.getQueryData<EnvVar[]>(queryKeys.env) ?? [];
    const sameFile = (item: EnvVar): boolean =>
      item.source === source || (source === 'settings' && item.source === 'group');
    const clash = existing.find(
      (item) => item.key === name && sameFile(item) && item.id !== envVar?.id,
    );
    if (clash) {
      setFormError(t('env.alreadyExists', { key: name, file: envFileName(source) }));
      return;
    }
    setFormError(undefined);
    save.mutate();
  };

  const canSave = key.trim().length > 0 && !save.isPending;
  const errorText = formError ?? (save.isError ? toErrorMessage(save.error) : undefined);

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
              onClick={submit}
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
            if (!ENV_KEY_PATTERN.test(name)) {
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
              <Badge tone={draft.isSecret ? 'warning' : 'neutral'}>
                {envFileName(draft.source)}
              </Badge>
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
            // Файл при правке определяется записью — помощник его не меняет.
            if (!envVar && (applied.source === 'settings' || applied.source === 'secrets')) {
              setSource(applied.source);
            }
            if (typeof applied.comment === 'string') setComment(applied.comment);
            setFormError(undefined);
          }}
        >
          <Stack gap="var(--spacing-md)">
            <TextField
              label={t('env.varKey')}
              value={key}
              onChange={(next) => {
                setKey(next);
                setFormError(undefined);
              }}
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

            {envVar ? (
              <Stack gap="var(--spacing-3xs)">
                <Typography variant="caption" color="subtle">
                  {t('env.file')}
                </Typography>
                <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                  <Badge tone={envVar.source === 'secrets' ? 'warning' : 'neutral'}>
                    {envFileName(envVar.source)}
                  </Badge>
                  <Typography variant="caption" color="subtle">
                    {t('env.sourceLocked')}
                  </Typography>
                </Stack>
              </Stack>
            ) : (
              <SelectField
                label={t('env.source')}
                value={source}
                onChange={(next) => {
                  setSource(next as EnvSource);
                  setFormError(undefined);
                }}
                options={[
                  { value: 'secrets', label: '.mcp-secrets.env' },
                  { value: 'settings', label: 'settings.json' },
                ]}
                hint={t('env.explain')}
              />
            )}

            <TextField
              label={t('env.varComment')}
              value={comment}
              onChange={setComment}
              placeholder={t('env.varCommentPlaceholder')}
            />

            {errorText && (
              <Typography variant="body-sm" color="danger" role="alert">
                {errorText}
              </Typography>
            )}
          </Stack>
        </FormWithAssistant>
      )}
    </Modal>
  );
}
