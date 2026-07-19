import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { FormWithAssistant } from '@shared/ui/form-with-assistant';
import { useSaveScript, useScriptContent } from '@entities/Script/api/ScriptApi';
import { NEW_SCRIPT_TEMPLATE } from '../model/ScriptTemplate';
import type { ScriptFormModalProps } from './ScriptFormModal.types';

/**
 * Редактор файла скрипта. В отличие от остальных форм здесь одно большое поле
 * с кодом: помощник пишет тело скрипта целиком, а не заполняет набор полей.
 */
export function ScriptFormModal({ isOpen, onOpenChange, script }: ScriptFormModalProps) {
  const { t } = useTranslation();

  const [name, setName] = useState('');
  const [content, setContent] = useState('');

  const loaded = useScriptContent(isOpen ? script?.id : undefined);
  const save = useSaveScript();

  useEffect(() => {
    if (!isOpen) return;
    setName(script?.name ?? '');
    setContent(script ? '' : NEW_SCRIPT_TEMPLATE);
  }, [isOpen, script]);

  // Содержимое приезжает вторым запросом — подставляем, когда оно готово.
  useEffect(() => {
    if (loaded.data !== undefined) setContent(loaded.data);
  }, [loaded.data]);

  const submit = (): void => {
    save.mutate(
      { id: script?.id, name: name.trim(), content },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  const canSave = name.trim().length > 0 && content.length > 0 && !save.isPending;

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={script ? `${t('common.edit')}: ${script.name}` : t('scripts.addScript')}
      description={t('scripts.formHint')}
      size="xl"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={submit} disabled={!canSave} isLoading={save.isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <FormWithAssistant
        kind={t('scripts.title')}
        fields={{ name, content }}
        schema={{
          name: 'Имя файла скрипта с расширением, например notify.mjs',
          content:
            'Полный код скрипта. Хуки Claude Code получают JSON на stdin и могут вернуть JSON на stdout; ' +
            'код выхода 2 блокирует действие. Пиши на Node.js (.mjs), комментарии по-русски',
        }}
        onApply={(applied) => {
          if (typeof applied.name === 'string') setName(applied.name);
          if (typeof applied.content === 'string') setContent(applied.content);
        }}
      >
        <Stack gap="var(--spacing-md)">
          <TextField
            label={t('scripts.fileName')}
            value={name}
            onChange={setName}
            placeholder="notify.mjs"
            hint={script ? t('scripts.renameHint') : t('scripts.fileNameHint')}
            isMono
            autoFocus={!script}
          />

          <TextField
            label={t('scripts.code')}
            value={content}
            onChange={setContent}
            multiline
            rows={18}
            isMono
            placeholder={loaded.isLoading ? t('common.loading') : ''}
          />

          {save.isError && (
            <Typography variant="body-sm" color="danger">
              {t('errors.saveFailed')}
            </Typography>
          )}
        </Stack>
      </FormWithAssistant>
    </Modal>
  );
}
