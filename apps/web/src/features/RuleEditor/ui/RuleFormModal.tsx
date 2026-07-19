import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { FormWithAssistant } from '@shared/ui/form-with-assistant';
import { ruleApi } from '@entities/Rule';
import type { RuleFormModalProps } from './RuleFormModal.types';

/**
 * Создание и правка правила из CLAUDE.md. Файл перезаписывается целиком,
 * поэтому перед сохранением сервер делает резервную копию — об этом
 * сообщается после записи.
 */
export function RuleFormModal({ isOpen, onOpenChange, rule }: RuleFormModalProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  const create = ruleApi.useCreate();
  const update = ruleApi.useUpdate();

  // Подставляем значения при каждом открытии: иначе в форме останется
  // предыдущее правило, если окно открыть повторно для другого.
  useEffect(() => {
    if (!isOpen) return;
    setTitle(rule?.title ?? '');
    setBody(rule?.body ?? '');
  }, [isOpen, rule]);

  const isPending = create.isPending || update.isPending;
  const canSave = title.trim().length > 0 && !isPending;

  const handleSave = (): void => {
    const draft = { title: title.trim(), body, isEnabled: rule?.isEnabled ?? true, groupIds: [] };

    const onDone = { onSuccess: () => onOpenChange(false) };
    if (rule) update.mutate({ id: rule.id, draft }, onDone);
    else create.mutate(draft, onDone);
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={rule ? t('common.edit') : t('rules.addRule')}
      description={t('common.needsRestart')}
      size="xl"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={handleSave} disabled={!canSave} isLoading={isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <FormWithAssistant
        kind={t('rules.title')}
        fields={{ title, body }}
        schema={{
          title: 'Короткий заголовок правила',
          body: 'Текст правила в markdown: что делать, чего не делать, как проверять',
        }}
        onApply={(applied) => {
          if (typeof applied.title === 'string') setTitle(applied.title);
          if (typeof applied.body === 'string') setBody(applied.body);
        }}
      >
        <Stack gap="var(--spacing-md)">
          <TextField
            label={t('rules.ruleTitle')}
            value={title}
            onChange={setTitle}
            placeholder="например: язык общения — всегда русский"
            autoFocus
          />

          <TextField
            label={t('rules.ruleBody')}
            value={body}
            onChange={setBody}
            multiline
            rows={14}
            hint={t('rules.explain')}
          />

          {(create.isError || update.isError) && (
            <Typography variant="body-sm" color="danger">
              {t('errors.saveFailed')}
            </Typography>
          )}
        </Stack>
      </FormWithAssistant>
    </Modal>
  );
}
