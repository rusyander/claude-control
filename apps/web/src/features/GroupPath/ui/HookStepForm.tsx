import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HOOK_EVENT_INFO } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { Typography } from '@shared/ui/typography';
import type { HookStepFormProps } from './HookStepForm.types';

/**
 * Вид шага «Хук» — бывшая форма «Сценария»: событие, фильтр, команда. Хук
 * пишется в settings.json, становится участником группы, а шаг ссылается на
 * него. Название шага нужно, чтобы строка в порядке работы читалась словами,
 * а не хэшем хука.
 */
export function HookStepForm({ isSaving, failure, onCreate }: HookStepFormProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [event, setEvent] = useState('PostToolUse');
  const [matcher, setMatcher] = useState('');
  const [command, setCommand] = useState('');
  const [isTouched, setIsTouched] = useState(false);
  const info = HOOK_EVENT_INFO.find((item) => item.event === event);
  const isTitleEmpty = !title.trim();
  const isCommandEmpty = !command.trim();

  const submit = (): void => {
    setIsTouched(true);
    if (isTitleEmpty || isCommandEmpty || isSaving) return;
    onCreate({ title, event, matcher: info?.supportsMatcher ? matcher : '', command });
  };

  return (
    <form
      onSubmit={(formEvent) => {
        formEvent.preventDefault();
        submit();
      }}
    >
      <Stack gap="var(--spacing-sm)">
        <Typography variant="body-sm" color="subtle">
          {t('groupBuilder.hookForm.hint')}
        </Typography>
        <TextField
          label={t('groupBuilder.hookForm.title')}
          value={title}
          onChange={setTitle}
          hint={t('groupBuilder.hookForm.titleHint')}
          error={isTouched && isTitleEmpty ? t('groupBuilder.hookForm.titleRequired') : undefined}
          autoFocus
        />
        <SelectField
          label={t('groupBuilder.hookForm.event')}
          value={event}
          onChange={setEvent}
          options={HOOK_EVENT_INFO.map((item) => ({ value: item.event, label: item.event }))}
        />
        {info?.supportsMatcher && (
          <TextField
            label={t('groupBuilder.hookForm.matcher')}
            value={matcher}
            onChange={setMatcher}
            hint={t('groupBuilder.hookForm.matcherHint')}
            isMono
          />
        )}
        <TextField
          label={t('groupBuilder.hookForm.command')}
          value={command}
          onChange={setCommand}
          hint={t('groupBuilder.hookForm.commandHint')}
          error={
            isTouched && isCommandEmpty ? t('groupBuilder.hookForm.commandRequired') : undefined
          }
          isMono
        />
        {failure && (
          <Typography variant="body-sm" color="danger" role="alert">
            {t('groupBuilder.hookForm.failed', { reason: failure })}
          </Typography>
        )}
        <div>
          <Button type="submit" variant="primary" isLoading={isSaving}>
            {t('groupBuilder.hookForm.create')}
          </Button>
        </div>
      </Stack>
    </form>
  );
}
