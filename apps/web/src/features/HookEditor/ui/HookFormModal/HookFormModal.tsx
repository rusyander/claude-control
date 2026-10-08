import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HOOK_EVENT_INFO, type HookEvent } from '@agentdeck/contracts';
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
import { presetText } from '@shared/config/i18n';
import { hookApi } from '@entities/Hook';
import { HOOK_PRESETS, type HookPreset } from '../../model/hookPresets';
import { hookAssistantSpec } from '../../model/hookAssistant';
import { MatcherPicker } from '../MatcherPicker/MatcherPicker';
import { TemplateFields } from '../TemplateFields/TemplateFields';
import type { HookFormModalProps } from './HookFormModal.types';
import styles from './HookFormModal.module.scss';
import { toErrorMessage } from '../../../../shared/api/toErrorMessage';

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
  // Таймаут в секундах, строкой: пусто — умолчание Claude Code.
  const [timeoutSec, setTimeoutSec] = useState('');
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
    setTimeoutSec(hook?.timeout === undefined ? '' : String(hook.timeout));
    setMode('constructor');
  }, [isOpen, hook]);

  /** Текст заготовки на языке интерфейса; им же заполняются поля хука. */
  const hookPresetText = (preset: HookPreset, field: 'title' | 'description' | 'message') => {
    const source = preset[field];
    return source ? presetText(t, 'hook', preset.id, field, source) : '';
  };

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
      description: hookPresetText(preset, 'description'),
      message: hookPresetText(preset, 'message'),
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
    setDescription(hookPresetText(preset, 'description'));
    setMessage(hookPresetText(preset, 'message'));
    setGuardPatterns(preset.guardPatterns ?? '');
    setCommand(preset.command ?? '');
  };

  const isPending = create.isPending || update.isPending;
  const timeoutOk = timeoutSec.trim() === '' || /^[1-9]\d*$/.test(timeoutSec.trim());
  // Либо создаём файл по имени, либо задаём команду напрямую — что-то одно.
  const canSave =
    (scriptName.trim().length > 0 || command.trim().length > 0) && timeoutOk && !isPending;

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
      // Таймаут раньше формой не передавался, и правка молча стирала его из файла.
      timeout: timeoutSec.trim() === '' ? undefined : Number(timeoutSec.trim()),
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
            title: hookPresetText(preset, 'title'),
            description: hookPresetText(preset, 'description'),
          }))}
          createOne={(id) => {
            const draft = draftFromPreset(id);
            return draft ? create.mutateAsync(draft) : Promise.resolve();
          }}
          onDone={() => onOpenChange(false)}
        />
      ) : (
        <FormWithAssistant
          kind="hook"
          fields={{
            event,
            matchers,
            scriptName,
            template,
            description,
            message,
            guardPatterns,
            command,
            timeout: timeoutSec.trim() === '' ? null : Number(timeoutSec.trim()),
          }}
          spec={hookAssistantSpec()}
          onApply={(applied) => {
            if (applied.event !== undefined) setEvent(applied.event as HookEvent);
            if (applied.matchers !== undefined) setMatchers(applied.matchers);
            if (applied.scriptName !== undefined) setScriptName(applied.scriptName);
            if (applied.template !== undefined) setTemplate(applied.template);
            if (applied.description !== undefined) setDescription(applied.description);
            if (applied.message !== undefined) setMessage(applied.message);
            if (applied.guardPatterns !== undefined) setGuardPatterns(applied.guardPatterns);
            if (applied.command !== undefined) setCommand(applied.command);
            // null — сброс к умолчанию Claude Code, как пустое поле у человека.
            if (applied.timeout !== undefined) {
              setTimeoutSec(applied.timeout === null ? '' : String(applied.timeout));
            }
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
                        title={hookPresetText(preset, 'description')}
                      >
                        {hookPresetText(preset, 'title')}
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
                      {presetText(t, 'hookEvent', eventInfo.event, 'when', eventInfo.when)}
                    </Typography>
                    {eventInfo.canBlock && <Badge tone="warning">{t('hooks.canBlock')}</Badge>}
                  </Stack>
                  <Typography variant="caption" color="muted">
                    {presetText(t, 'hookEvent', eventInfo.event, 'useFor', eventInfo.useFor)}
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

            {/* У существующего хука в файле лежит только команда — её и правим.
                Раньше форма её прятала: шаблон сбрасывался на «подсказку», а поле
                команды показывалось лишь у шаблона «команда». Шаблоны — только
                когда просят создать новый файл (введено имя скрипта). */}
            {hook && (
              <TextField
                label={t('hooks.command')}
                value={command}
                onChange={setCommand}
                hint={t('hooks.commandHint')}
                isMono
              />
            )}

            <TextField
              label={t('hooks.timeout')}
              value={timeoutSec}
              onChange={setTimeoutSec}
              placeholder="60"
              hint={t('hooks.timeoutHint')}
              isMono
            />

            {(!hook || scriptName.trim().length > 0) && (
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
            )}

            {/* Причину — в форму: тост с ней всплывает поверх кнопок и под
                курсором, а общий «Не удалось сохранить» не говорит, что менять. */}
            {(create.isError || update.isError) && (
              <Typography variant="body-sm" color="danger">
                {toErrorMessage(create.error ?? update.error ?? t('errors.saveFailed'))}
              </Typography>
            )}
          </Stack>
        </FormWithAssistant>
      )}
    </Modal>
  );
}
