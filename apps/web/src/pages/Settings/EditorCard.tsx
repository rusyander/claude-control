import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { useSettings, useUpdateSettings } from '@entities/AppConfig';
import { useEditors } from '@entities/Project';

/**
 * Выбор редактора кода для «Открыть в редакторе». Показываем установленные в
 * системе редакторы, отсутствующие — приглушёнными. «Авто» берёт первый
 * найденный. Своя команда — на случай редактора не из списка.
 */
export function EditorCard() {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const editors = useEditors();
  const updateSettings = useUpdateSettings();
  const [custom, setCustom] = useState('');

  const current = settings?.editor ?? '';
  const known = editors.data ?? [];
  const isCustom = current !== '' && !known.some((editor) => editor.command === current);

  const choose = (editor: string): void => updateSettings.mutate({ editor });

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="body" weight="medium">
          {t('settings.editorTitle')}
        </Typography>
        <Typography variant="body-sm" color="muted">
          {t('settings.editorHint')}
        </Typography>

        <Stack direction="row" gap="var(--spacing-xs)" wrap>
          <Button
            variant={current === '' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => choose('')}
          >
            {t('settings.editorAuto')}
          </Button>

          {known.map((editor) => (
            <Button
              key={editor.id}
              variant={current === editor.command ? 'primary' : 'secondary'}
              size="sm"
              disabled={!editor.available}
              title={editor.available ? editor.command : t('settings.editorMissing')}
              onClick={() => choose(editor.command)}
            >
              {editor.name}
              {!editor.available && ` · ${t('settings.editorMissing')}`}
            </Button>
          ))}
        </Stack>

        <Stack direction="row" align="end" gap="var(--spacing-xs)">
          <Stack flex={1}>
            <TextField
              label={t('settings.editorCustom')}
              value={isCustom ? current : custom}
              onChange={isCustom ? choose : setCustom}
              placeholder="idea, subl, mate…"
              isMono
              hint={t('settings.editorCustomHint')}
            />
          </Stack>
          {!isCustom && (
            <Button
              variant="secondary"
              size="sm"
              disabled={!custom.trim()}
              onClick={() => choose(custom.trim())}
            >
              {t('common.save')}
            </Button>
          )}
        </Stack>
      </Stack>
    </Card>
  );
}
