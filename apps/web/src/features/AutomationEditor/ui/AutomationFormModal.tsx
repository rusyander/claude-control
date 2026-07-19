import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HOOK_EVENT_INFO } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { FormWithAssistant } from '@shared/ui/form-with-assistant';
import { useSaveAutomation } from '@entities/Group';
import { skillApi } from '@entities/Skill';
import type { AutomationFormModalProps } from './AutomationFormModal.types';

/**
 * Редактор сценария «когда — что». Он не даёт новых возможностей сверх хуков,
 * но избавляет от необходимости помнить, какое событие и какой фильтр писать:
 * достаточно выбрать скилл из списка, и фильтр подставится сам.
 */
export function AutomationFormModal({
  isOpen,
  onOpenChange,
  automation,
}: AutomationFormModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [event, setEvent] = useState('PostToolUse');
  const [matcher, setMatcher] = useState('Skill');
  const [command, setCommand] = useState('');

  const saveAutomation = useSaveAutomation();
  const skills = skillApi.useList().data ?? [];

  useEffect(() => {
    if (!isOpen) return;
    setName(automation?.name ?? '');
    setEvent(automation?.trigger.event ?? 'PostToolUse');
    setMatcher(automation?.trigger.matcher ?? 'Skill');
    setCommand(automation?.action.command ?? '');
  }, [isOpen, automation]);

  const eventInfo = useMemo(() => HOOK_EVENT_INFO.find((info) => info.event === event), [event]);

  const canSave = name.trim().length > 0 && command.trim().length > 0 && !saveAutomation.isPending;

  const handleSave = (): void => {
    saveAutomation.mutate(
      {
        id: automation?.id,
        automation: {
          name: name.trim(),
          description: '',
          trigger: { event, matcher: eventInfo?.supportsMatcher ? matcher.trim() : undefined },
          action: { command: command.trim() },
          isEnabled: automation?.isEnabled ?? true,
          groupIds: [],
        },
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={automation ? `${t('common.edit')}: ${automation.name}` : t('groups.addAutomation')}
      description={t('groups.automationsExplain')}
      size="xl"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={!canSave}
            isLoading={saveAutomation.isPending}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <FormWithAssistant
        kind={t('groups.automations')}
        fields={{ name, event, matcher, command }}
        schema={{
          name: 'Название сценария',
          event: `Событие Claude Code, одно из: ${HOOK_EVENT_INFO.map((info) => info.event).join(', ')}`,
          matcher: 'Фильтр: имя инструмента или Skill(имя-скилла)',
          command: 'Команда оболочки, которую нужно выполнить',
        }}
        onApply={(applied) => {
          if (typeof applied.name === 'string') setName(applied.name);
          if (typeof applied.event === 'string') setEvent(applied.event);
          if (typeof applied.matcher === 'string') setMatcher(applied.matcher);
          if (typeof applied.command === 'string') setCommand(applied.command);
        }}
      >
        <Stack gap="var(--spacing-md)">
          <TextField
            label={t('groups.automationName')}
            value={name}
            onChange={setName}
            placeholder="например: после ревью прогнать линт"
            autoFocus={!automation}
          />

          <Card padding="md">
            <Stack gap="var(--spacing-sm)">
              <Typography variant="body-sm" weight="medium">
                {t('groups.automationTrigger')}
              </Typography>

              <SelectField
                label={t('hooks.event')}
                value={event}
                onChange={setEvent}
                options={HOOK_EVENT_INFO.map((info) => ({ value: info.event, label: info.event }))}
              />

              {eventInfo?.supportsMatcher && (
                <>
                  <TextField
                    label={t('hooks.matcher')}
                    value={matcher}
                    onChange={setMatcher}
                    hint={t('hooks.matcherHint')}
                    isMono
                  />

                  {/* Быстрый выбор скилла: подставляет фильтр вида Skill(имя),
                    чтобы не набирать его руками и не ошибиться в написании. */}
                  {skills.length > 0 && (
                    <Stack direction="row" gap="var(--spacing-2xs)" wrap>
                      <Button size="sm" variant="ghost" onClick={() => setMatcher('Skill')}>
                        {t('groups.kind_skill')}: {t('common.total')}
                      </Button>
                      {skills.slice(0, 6).map((skill) => (
                        <Button
                          key={skill.id}
                          size="sm"
                          variant="ghost"
                          onClick={() => setMatcher(`Skill(${skill.name})`)}
                        >
                          {skill.name}
                        </Button>
                      ))}
                    </Stack>
                  )}
                </>
              )}
            </Stack>
          </Card>

          <Card padding="md">
            <Stack gap="var(--spacing-sm)">
              <Typography variant="body-sm" weight="medium">
                {t('groups.automationAction')}
              </Typography>
              <TextField
                label={t('hooks.command')}
                value={command}
                onChange={setCommand}
                multiline
                rows={3}
                placeholder="pnpm lint"
                hint={t('hooks.commandHint')}
                isMono
              />
            </Stack>
          </Card>

          {saveAutomation.isError && (
            <Typography variant="body-sm" color="danger">
              {t('errors.saveFailed')}
            </Typography>
          )}
        </Stack>
      </FormWithAssistant>
    </Modal>
  );
}
