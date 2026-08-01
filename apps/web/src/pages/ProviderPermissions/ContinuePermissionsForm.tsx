import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { TextField } from '@shared/ui/text-field';
import { listToText, textToList, sameList } from '@entities/ProviderPermissions';
import type { ContinuePermissionsFormProps } from './ProviderPermissionsForm.types';

/**
 * Форма прав Continue — три списка `allow` / `ask` / `exclude` из отдельного файла
 * `permissions.yaml`. Одна и та же на глобальный раздел и на таб проекта:
 * отличается только шапка, поэтому она приходит снаружи (`header`).
 *
 * Режима-переключателя, как у Codex/Gemini/Qwen, у Continue НЕТ — это вся модель
 * прав целиком. Правила (`Read(*)`, `Bash`, инструмент с шаблоном путей) панель
 * не толкует и хранит как есть: одно правило в строке. Пустой список удаляет свой
 * ключ из файла.
 */
export function ContinuePermissionsForm({ data, header, onSave }: ContinuePermissionsFormProps) {
  const { t } = useTranslation();

  const [allowText, setAllowText] = useState(listToText(data.allow));
  const [askText, setAskText] = useState(listToText(data.ask));
  const [excludeText, setExcludeText] = useState(listToText(data.exclude));

  // Синхронизируем локальную форму с сервером при загрузке/обновлении данных.
  useEffect(() => {
    setAllowText(listToText(data.allow));
    setAskText(listToText(data.ask));
    setExcludeText(listToText(data.exclude));
  }, [data]);

  const readOnly = data.readOnly;
  const allow = textToList(allowText);
  const ask = textToList(askText);
  const exclude = textToList(excludeText);
  const dirty =
    !sameList(allow, data.allow) || !sameList(ask, data.ask) || !sameList(exclude, data.exclude);

  const submit = (): void => {
    onSave({ allow, ask, exclude });
  };

  return (
    <Stack gap="var(--spacing-lg)">
      {header({ dirty, submit })}

      <Card padding="md">
        <Stack gap="var(--spacing-lg)">
          <TextField
            label={t('providerPermissions.continue.allow.label')}
            value={allowText}
            onChange={setAllowText}
            hint={t('providerPermissions.continue.allow.hint')}
            placeholder={t('providerPermissions.continue.rulesPlaceholder')}
            multiline
            rows={4}
            isMono
            disabled={readOnly}
          />

          <TextField
            label={t('providerPermissions.continue.ask.label')}
            value={askText}
            onChange={setAskText}
            hint={t('providerPermissions.continue.ask.hint')}
            placeholder={t('providerPermissions.continue.rulesPlaceholder')}
            multiline
            rows={4}
            isMono
            disabled={readOnly}
          />

          <TextField
            label={t('providerPermissions.continue.exclude.label')}
            value={excludeText}
            onChange={setExcludeText}
            hint={t('providerPermissions.continue.exclude.hint')}
            placeholder={t('providerPermissions.continue.rulesPlaceholder')}
            multiline
            rows={4}
            isMono
            disabled={readOnly}
          />
        </Stack>
      </Card>
    </Stack>
  );
}
