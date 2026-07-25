import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CursorPermissionInfo } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';

/**
 * Форма прав Cursor — ДВА списка правил, `allow` и `deny`, из ключа `permissions`
 * (`~/.cursor/cli-config.json` глобально, `<проект>/.cursor/cli.json` в проекте).
 * Одна и та же на глобальный раздел и на таб проекта: отличается только шапка,
 * поэтому она приходит снаружи (`header`).
 *
 * Ни режима-переключателя, ни списка `ask` у Cursor НЕТ — это вся модель целиком.
 * `deny` приоритетнее `allow`: правило, попавшее в оба списка, запрещено. Правила
 * панель не толкует и хранит как есть, одно правило в строке; задокументированные
 * формы показаны подсказкой под полями.
 */

/** Список правил ↔ текст: одно правило в строке (пустые строки игнорируются). */
const listToText = (list: string[]): string => list.join('\n');
function textToList(text: string): string[] {
  const list: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const rule = line.trim();
    if (rule && !list.includes(rule)) list.push(rule);
  }
  return list;
}
const sameList = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/** Черновик, который форма отдаёт наружу на сохранение. */
export interface CursorPermissionsDraft {
  allow: string[];
  deny: string[];
}

export interface CursorPermissionsFormProps {
  data: CursorPermissionInfo;
  onSave: (draft: CursorPermissionsDraft) => void;
  /** Шапка раздела: своя у глобальной страницы и у таба проекта. */
  header: (state: { dirty: boolean; submit: () => void }) => React.ReactNode;
}

export function CursorPermissionsForm({ data, header, onSave }: CursorPermissionsFormProps) {
  const { t } = useTranslation();

  const [allowText, setAllowText] = useState(listToText(data.allow));
  const [denyText, setDenyText] = useState(listToText(data.deny));

  // Синхронизируем локальную форму с сервером при загрузке/обновлении данных.
  useEffect(() => {
    setAllowText(listToText(data.allow));
    setDenyText(listToText(data.deny));
  }, [data]);

  const readOnly = data.readOnly;
  const allow = textToList(allowText);
  const deny = textToList(denyText);
  const dirty = !sameList(allow, data.allow) || !sameList(deny, data.deny);

  const submit = (): void => {
    onSave({ allow, deny });
  };

  return (
    <Stack gap="var(--spacing-lg)">
      {header({ dirty, submit })}

      <Card padding="md">
        <Stack gap="var(--spacing-lg)">
          <TextField
            label={t('providerPermissions.cursor.allow.label')}
            value={allowText}
            onChange={setAllowText}
            hint={t('providerPermissions.cursor.allow.hint')}
            placeholder={t('providerPermissions.cursor.rulesPlaceholder')}
            multiline
            rows={5}
            isMono
            disabled={readOnly}
          />

          <TextField
            label={t('providerPermissions.cursor.deny.label')}
            value={denyText}
            onChange={setDenyText}
            hint={t('providerPermissions.cursor.deny.hint')}
            placeholder={t('providerPermissions.cursor.rulesPlaceholder')}
            multiline
            rows={5}
            isMono
            disabled={readOnly}
          />

          <Typography variant="caption" color="subtle">
            {t('providerPermissions.cursor.ruleKinds', { kinds: data.ruleKinds.join(' · ') })}
          </Typography>
        </Stack>
      </Card>
    </Stack>
  );
}
