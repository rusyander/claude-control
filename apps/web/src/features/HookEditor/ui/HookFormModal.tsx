import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HOOK_EVENT_INFO, type HookEvent } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { FormWithAssistant } from '@shared/ui/form-with-assistant';
import { BulkPresets } from '@shared/ui/bulk-presets';
import { hookApi } from '@entities/Hook';
import { HOOK_PRESETS, type HookPreset } from '../model/hookPresets';
import { MatcherPicker } from './MatcherPicker';
import { TemplateFields } from './TemplateFields';
import type { HookFormModalProps } from './HookFormModal.types';
import styles from './HookFormModal.module.scss';

/**
 * Создание хука без ручной работы с файлами: выбираете событие, отмечаете
 * инструменты и описываете действие — файл скрипта приложение создаёт само
 * и подставляет команду запуска. Готовый файл потом можно свободно править.
 */
export function HookFormModal({ isOpen, onOpenChange, hook }: HookFormModalProps) {
  const { t } = useTranslation();

  const [event, setEvent] = useState<HookEvent>('PreToolUse');
  const [matchers, setMatchers] = useState<string[]>([]);
  const [scriptName, setScriptName] = useState('');
  const [template, setTemplate] = useState('message');
  const [description, setDescription] = useState('');
  const [message, setMessage] = useState('');
  const [guardPatterns, setGuardPatterns] = useState('');
  const [command, setCommand] = useState('');
  // Конструктор (одно) или набор заготовок сразу.
  const [mode, setMode] = useState<'constructor' | 'bulk'>('constructor');

  const create = hookApi.useCreate();
  const update = hookApi.useUpdate();

  useEffect(() => {
    if (!isOpen) return;
    setEvent(hook?.event ?? 'PreToolUse');
    setMatchers(hook?.matcher ? hook.matcher.split('|') : []);
    setScriptName('');
    setTemplate('message');
    setDescription(hook?.description ?? '');
    setMessage('');
    setGuardPatterns('');
    setCommand(hook?.command ?? '');
    setMode('constructor');
  }, [isOpen, hook]);

  /** Заготовка → черновик хука (для пакетного создания). */
  const draftFromPreset = (id: string) => {
    const preset = HOOK_PRESETS.find((item) => item.id === id);
    if (!preset) return undefined;
    return {
      event: preset.event,
      matchers: preset.matchers,
      isEnabled: true,
      groupIds: [],
      scriptName: preset.scriptName || undefined,
      template: preset.template,
      description: preset.description,
      message: preset.message ?? '',
      guardPatterns: (preset.guardPatterns ?? '')
        .split(',')
        .map((pattern) => pattern.trim())
        .filter(Boolean),
      command: preset.command ?? '',
    };
  };

  const eventInfo = useMemo(() => HOOK_EVENT_INFO.find((info) => info.event === event), [event]);

  /** Заполняет форму готовым хуком — все увязанные поля разом. */
  const applyPreset = (preset: HookPreset): void => {
    setEvent(preset.event);
    setMatchers(preset.matchers);
    setTemplate(preset.template);
    setScriptName(preset.scriptName);
    setDescription(preset.description);
    setMessage(preset.message ?? '');
    setGuardPatterns(preset.guardPatterns ?? '');
    setCommand(preset.command ?? '');
  };

  const isPending = create.isPending || update.isPending;
  // Либо создаём файл по имени, либо задаём команду напрямую — что-то одно.
  const canSave = (scriptName.trim().length > 0 || command.trim().length > 0) && !isPending;

  const handleSave = (): void => {
    const draft = {
      event,
      matchers: eventInfo?.supportsMatcher ? matchers : [],
      isEnabled: hook?.isEnabled ?? true,
      groupIds: [],
      scriptName: scriptName.trim() || undefined,
      template,
      description: description.trim(),
      message: message.trim(),
      guardPatterns: guardPatterns
        .split(',')
        .map((pattern) => pattern.trim())
        .filter(Boolean),
      command: command.trim(),
    };

    const onDone = { onSuccess: () => onOpenChange(false) };
    if (hook) update.mutate({ id: hook.id, draft }, onDone);
    else create.mutate(draft, onDone);
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={hook ? t('common.edit') : t('hooks.addHook')}
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
      {!hook && (
        <Stack direction="row" gap="var(--spacing-3xs)" className={styles.modeTabs}>
          {(['constructor', 'bulk'] as const).map((item) => (
            <Button
              key={item}
              size="sm"
              variant={mode === item ? 'primary' : 'ghost'}
              onClick={() => setMode(item)}
            >
              {t(`hooks.mode_${item}`)}
            </Button>
          ))}
        </Stack>
      )}

      {mode === 'bulk' ? (
        <BulkPresets
          items={HOOK_PRESETS.map((preset) => ({
            id: preset.id,
            title: preset.title,
            description: preset.description,
          }))}
          createOne={(id) => {
            const draft = draftFromPreset(id);
            return draft ? create.mutateAsync(draft) : Promise.resolve();
          }}
          onDone={() => onOpenChange(false)}
        />
      ) : (
        <FormWithAssistant
          kind={t('hooks.title')}
          fields={{
            event,
            matchers: matchers.join(','),
            scriptName,
            template,
            description,
            message,
            guardPatterns,
            command,
          }}
          schema={{
            event: `Событие Claude Code, одно из: ${HOOK_EVENT_INFO.map((info) => info.event).join(', ')}`,
            matchers: 'Инструменты через запятую, например Bash,Write',
            scriptName: 'Имя файла скрипта без расширения, латиницей через дефис',
            template:
              'Тип действия: message (подсказка), guard (запрет), shell (команда), blank (пусто)',
            description: 'Одной фразой, что делает хук',
            message: 'Текст подсказки или сообщения при срабатывании запрета',
            guardPatterns: 'Для типа guard: что перехватывать, через запятую',
            command: 'Для типа shell: команда оболочки',
          }}
          onApply={(applied) => {
            if (typeof applied.event === 'string') setEvent(applied.event as HookEvent);
            if (typeof applied.matchers === 'string') {
              setMatchers(
                applied.matchers
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean),
              );
            }
            if (typeof applied.scriptName === 'string') setScriptName(applied.scriptName);
            if (typeof applied.template === 'string') setTemplate(applied.template);
            if (typeof applied.description === 'string') setDescription(applied.description);
            if (typeof applied.message === 'string') setMessage(applied.message);
            if (typeof applied.guardPatterns === 'string') setGuardPatterns(applied.guardPatterns);
            if (typeof applied.command === 'string') setCommand(applied.command);
          }}
        >
          <Stack gap="var(--spacing-md)">
            {/* Готовые хуки — при создании. У существующего подмена всех полей
              разом почти наверняка не то, чего ждут. */}
            {!hook && (
              <Card padding="md">
                <Stack gap="var(--spacing-sm)">
                  <Typography variant="body-sm" weight="medium">
                    {t('hooks.presetsTitle')}
                  </Typography>
                  <Typography variant="caption" color="subtle">
                    {t('hooks.presetsHint')}
                  </Typography>

                  <Stack direction="row" gap="var(--spacing-2xs)" wrap>
                    {HOOK_PRESETS.map((preset) => (
                      <Button
                        key={preset.id}
                        size="sm"
                        variant="secondary"
                        onClick={() => applyPreset(preset)}
                        title={preset.description}
                      >
                        {preset.title}
                      </Button>
                    ))}
                  </Stack>
                </Stack>
              </Card>
            )}

            <SelectField
              label={t('hooks.event')}
              value={event}
              onChange={(value) => setEvent(value as HookEvent)}
              options={HOOK_EVENT_INFO.map((info) => ({ value: info.event, label: info.event }))}
            />

            {eventInfo && (
              <Card padding="md" className={styles.eventInfo}>
                <Stack gap="var(--spacing-2xs)">
                  <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                    <Typography variant="body-sm" weight="medium" as="span">
                      {eventInfo.when}
                    </Typography>
                    {eventInfo.canBlock && <Badge tone="warning">{t('hooks.canBlock')}</Badge>}
                  </Stack>
                  <Typography variant="caption" color="muted">
                    {eventInfo.useFor}
                  </Typography>
                </Stack>
              </Card>
            )}

            {eventInfo?.supportsMatcher ? (
              <MatcherPicker
                value={matchers}
                onChange={setMatchers}
                suggestions={eventInfo.matcherExamples}
              />
            ) : (
              <Typography variant="caption" color="subtle">
                {t('hooks.noMatcherSupport')}
              </Typography>
            )}

            <TextField
              label={t('hooks.scriptName')}
              value={scriptName}
              onChange={setScriptName}
              placeholder="my-hook"
              hint={t('hooks.scriptNameHint')}
              isMono
            />

            <TextField
              label={t('hooks.description')}
              value={description}
              onChange={setDescription}
              placeholder={t('hooks.descriptionPlaceholder')}
            />

            <TemplateFields
              template={template}
              onTemplateChange={setTemplate}
              message={message}
              onMessageChange={setMessage}
              guardPatterns={guardPatterns}
              onGuardPatternsChange={setGuardPatterns}
              command={command}
              onCommandChange={setCommand}
            />

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
