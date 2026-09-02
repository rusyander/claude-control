import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { FormWithAssistant } from '@shared/ui/form-with-assistant';
import { Card } from '@shared/ui/card';
import { BulkPresets } from '@shared/ui/bulk-presets';
import { toErrorMessage } from '@shared/api/client';
import { useSaveScript, useScriptContent } from '@entities/Script';
import { useIsCapabilityReady } from '@entities/Provider';
import { scriptTemplatesFor, newScriptTemplateFor } from '../model/ScriptTemplate';
import type { ScriptFormModalProps } from './ScriptFormModal.types';
import styles from './ScriptFormModal.module.scss';

/**
 * Редактор файла скрипта. В отличие от остальных форм здесь одно большое поле
 * с кодом: помощник пишет тело скрипта целиком, а не заполняет набор полей.
 */
export function ScriptFormModal({ isOpen, onOpenChange, script }: ScriptFormModalProps) {
  const { t } = useTranslation();

  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [mode, setMode] = useState<'constructor' | 'bulk'>('constructor');

  const loaded = useScriptContent(isOpen ? script?.id : undefined);
  const save = useSaveScript();

  // Сам редактор общий для всех провайдеров, а вот заготовки и подсказка
  // помощнику говорят о хуках — их даём только там, где хуки есть (у Claude).
  const hasHooks = useIsCapabilityReady('hooks');
  const templates = scriptTemplatesFor(hasHooks);

  useEffect(() => {
    if (!isOpen) return;
    setName(script?.name ?? '');
    setContent(script ? '' : newScriptTemplateFor(hasHooks));
    setMode('constructor');
  }, [isOpen, script, hasHooks]);

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
        mode === 'bulk' ? (
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
      {!script && (
        <Stack direction="row" gap="var(--spacing-3xs)" className={styles.modeTabs}>
          {(['constructor', 'bulk'] as const).map((item) => (
            <Button
              key={item}
              size="sm"
              variant={mode === item ? 'primary' : 'ghost'}
              onClick={() => setMode(item)}
            >
              {t(`scripts.mode_${item}`)}
            </Button>
          ))}
        </Stack>
      )}

      {mode === 'bulk' ? (
        <BulkPresets
          items={templates.map((template) => ({
            id: template.id,
            title: template.title,
            description: template.description,
          }))}
          createOne={(id) => {
            const template = templates.find((item) => item.id === id);
            return template
              ? save.mutateAsync({ name: template.fileName, content: template.content })
              : Promise.resolve();
          }}
          onDone={() => onOpenChange(false)}
        />
      ) : (
        <FormWithAssistant
          kind={t('scripts.title')}
          fields={{ name, content }}
          schema={{
            name: 'Имя файла скрипта с расширением, например notify.mjs',
            content: hasHooks
              ? 'Полный код скрипта. Хуки Claude Code получают JSON на stdin и могут вернуть JSON на stdout; ' +
                'код выхода 2 блокирует действие. Пиши на Node.js (.mjs), комментарии по-русски'
              : 'Полный код самостоятельного скрипта: аргументы из process.argv, вывод в stdout, ' +
                'ненулевой код возврата при ошибке. Пиши на Node.js (.mjs), комментарии по-русски',
          }}
          onApply={(applied) => {
            if (typeof applied.name === 'string') setName(applied.name);
            if (typeof applied.content === 'string') setContent(applied.content);
          }}
        >
          <Stack gap="var(--spacing-md)">
            {/* Готовые каркасы — только при создании: подмена кода у
              существующего скрипта затёрла бы его содержимое. */}
            {!script && (
              <Card padding="md">
                <Stack gap="var(--spacing-sm)">
                  <Typography variant="body-sm" weight="medium">
                    {t('scripts.templatesTitle')}
                  </Typography>
                  <Typography variant="caption" color="subtle">
                    {t('scripts.templatesHint')}
                  </Typography>

                  <Stack direction="row" gap="var(--spacing-2xs)" wrap>
                    {templates.map((template) => (
                      <Button
                        key={template.id}
                        size="sm"
                        variant="secondary"
                        title={template.description}
                        onClick={() => {
                          setContent(template.content);
                          // Имя подставляем, только если пользователь его ещё не ввёл.
                          if (!name.trim()) setName(template.fileName);
                        }}
                      >
                        {template.title}
                      </Button>
                    ))}
                  </Stack>
                </Stack>
              </Card>
            )}

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

            {/* Причина — из ответа сервера (занятое имя, недопустимый путь):
                тост с ней всплывает под курсором над кнопками и от наведения
                замирает, поэтому текст стоит и здесь, в форме. */}
            {save.isError && (
              <Typography variant="body-sm" color="danger">
                {toErrorMessage(save.error ?? t('errors.saveFailed'))}
              </Typography>
            )}
          </Stack>
        </FormWithAssistant>
      )}
    </Modal>
  );
}
