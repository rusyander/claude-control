import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { FormWithAssistant } from '@shared/ui/form-with-assistant';
import { BulkCreate } from '@features/BulkCreate';
import { ruleApi } from '@entities/Rule';
import { RuleBuilder } from './RuleBuilder';
import {
  defaultSections,
  sectionsToMarkdown,
  hasContent,
  type RuleSection,
} from '../model/ruleSections';
import type { RuleFormModalProps } from './RuleFormModal.types';
import styles from './RuleFormModal.module.scss';

type Mode = 'simple' | 'builder' | 'bulk';

/**
 * Создание и правка правила из CLAUDE.md.
 *
 * Правило бывает простым абзацем, а бывает набором условий «что можно, что
 * нельзя». Поэтому вверху — выбор: простой текст, конструктор из блоков или
 * список сразу. Конструктор собирает markdown-тело сам, так что итог остаётся
 * обычным правилом и правится потом как угодно.
 */
export function RuleFormModal({ isOpen, onOpenChange, rule }: RuleFormModalProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [mode, setMode] = useState<Mode>('simple');
  const [sections, setSections] = useState<RuleSection[]>(defaultSections);

  const create = ruleApi.useCreate();
  const update = ruleApi.useUpdate();

  useEffect(() => {
    if (!isOpen) return;
    setTitle(rule?.title ?? '');
    setBody(rule?.body ?? '');
    setMode('simple');
    setSections(defaultSections());
  }, [isOpen, rule]);

  // В режиме конструктора тело собирается из блоков — правится не текст, а они.
  const builtBody = useMemo(() => sectionsToMarkdown(sections), [sections]);
  const effectiveBody = mode === 'builder' ? builtBody : body;

  const isPending = create.isPending || update.isPending;
  const canSave =
    title.trim().length > 0 && (mode !== 'builder' || hasContent(sections)) && !isPending;

  const handleSave = (): void => {
    const draft = {
      title: title.trim(),
      body: effectiveBody,
      isEnabled: rule?.isEnabled ?? true,
      groupIds: [],
    };

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
        mode === 'bulk' ? (
          <Button onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={!canSave}
              isLoading={isPending}
            >
              {t('common.save')}
            </Button>
          </>
        )
      }
    >
      {!rule && (
        <div className={styles.modeTabs}>
          {(['simple', 'builder', 'bulk'] as Mode[]).map((item) => (
            <Button
              key={item}
              size="sm"
              variant={mode === item ? 'primary' : 'ghost'}
              onClick={() => setMode(item)}
            >
              {t(`rules.mode_${item}`)}
            </Button>
          ))}
        </div>
      )}

      {mode === 'bulk' ? (
        <BulkCreate
          kindLabel={t('rules.title')}
          placeholder={
            'Язык общения :: Всегда отвечать по-русски\nБэкенд :: Не править бэкенд без разрешения'
          }
          parseLine={(line) => {
            // Строка формата «Заголовок :: текст». Без разделителя вся строка —
            // заголовок, тело пустое.
            const [head = '', ...rest] = line.split('::');
            const ruleTitle = head.trim();
            if (!ruleTitle) return { raw: line, error: t('bulk.emptyTitle') };
            return {
              raw: line,
              draft: {
                title: ruleTitle,
                body: rest.join('::').trim(),
                isEnabled: true,
                groupIds: [],
              },
            };
          }}
          createOne={(draft) => create.mutateAsync(draft)}
          renderPreview={(draft) => (
            <Stack direction="row" align="center" gap="var(--spacing-xs)">
              <Badge tone="neutral">{draft.title}</Badge>
              {draft.body && (
                <Typography variant="caption" color="subtle" as="span" truncate>
                  {draft.body}
                </Typography>
              )}
            </Stack>
          )}
          onDone={() => onOpenChange(false)}
        />
      ) : (
        <FormWithAssistant
          kind={t('rules.title')}
          fields={{ title, body: effectiveBody }}
          schema={{
            title: 'Короткий заголовок правила',
            body: 'Текст правила в markdown: что делать, чего не делать, как проверять',
          }}
          onApply={(applied) => {
            if (typeof applied.title === 'string') setTitle(applied.title);
            // Помощник заполняет текст — переключаемся в простой режим, чтобы
            // его правку было видно, а не поверх неё стояли блоки конструктора.
            if (typeof applied.body === 'string') {
              setBody(applied.body);
              setMode('simple');
            }
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

            {mode === 'builder' ? (
              <Stack gap="var(--spacing-2xs)">
                <Typography variant="body-sm" weight="medium">
                  {t('rules.builderTitle')}
                </Typography>
                <Typography variant="caption" color="subtle">
                  {t('rules.builderHint')}
                </Typography>
                <RuleBuilder sections={sections} onChange={setSections} />
              </Stack>
            ) : (
              <TextField
                label={t('rules.ruleBody')}
                value={body}
                onChange={setBody}
                multiline
                rows={14}
                hint={t('rules.explain')}
              />
            )}

            {(create.isError || update.isError) && (
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
