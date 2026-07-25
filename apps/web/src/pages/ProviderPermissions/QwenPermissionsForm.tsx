import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { QwenApprovalMode, QwenPermissionInfo } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Typography } from '@shared/ui/typography';
import { SelectField } from '@shared/ui/select-field/select-field';
import { TextField } from '@shared/ui/text-field';

/**
 * Форма прав Qwen Code — `tools.approvalMode` и три списка правил внутри
 * `permissions` файла `settings.json`. Одна и та же на глобальный раздел и на таб
 * проекта: отличается только шапка, поэтому она приходит снаружи (`header`).
 *
 * Правила — строки языка Qwen (`Bash(git push *)`, `Read(/src/**)`), панель их
 * синтаксис НЕ толкует и хранит как есть: одно правило в строке. Пустой список
 * удаляет свой ключ из файла, пустые все три — весь объект `permissions`.
 *
 * Режим `yolo` в списке присутствует СОЗНАТЕЛЬНО: у Qwen (в отличие от Gemini) он
 * задокументирован именно как значение `settings.json`. Риск каждого режима
 * подписан под селектом.
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
export interface QwenPermissionsDraft {
  approvalMode: QwenApprovalMode;
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface QwenPermissionsFormProps {
  data: QwenPermissionInfo;
  onSave: (draft: QwenPermissionsDraft) => void;
  /** Шапка раздела: своя у глобальной страницы и у таба проекта. */
  header: (state: { dirty: boolean; submit: () => void }) => React.ReactNode;
}

export function QwenPermissionsForm({ data, header, onSave }: QwenPermissionsFormProps) {
  const { t } = useTranslation();

  const [approvalMode, setApprovalMode] = useState<QwenApprovalMode>(data.approvalMode);
  const [allowText, setAllowText] = useState(listToText(data.allow));
  const [askText, setAskText] = useState(listToText(data.ask));
  const [denyText, setDenyText] = useState(listToText(data.deny));

  // Синхронизируем локальную форму с сервером при загрузке/обновлении данных.
  useEffect(() => {
    setApprovalMode(data.approvalMode);
    setAllowText(listToText(data.allow));
    setAskText(listToText(data.ask));
    setDenyText(listToText(data.deny));
  }, [data]);

  const readOnly = data.readOnly;
  const allow = textToList(allowText);
  const ask = textToList(askText);
  const deny = textToList(denyText);
  const dirty =
    approvalMode !== data.approvalMode ||
    !sameList(allow, data.allow) ||
    !sameList(ask, data.ask) ||
    !sameList(deny, data.deny);

  const modeOptions = data.approvalModes.map((value) => ({
    value,
    label: t(`providerPermissions.qwen.mode.${value}.label`),
  }));

  const submit = (): void => {
    onSave({ approvalMode, allow, ask, deny });
  };

  return (
    <Stack gap="var(--spacing-lg)">
      {header({ dirty, submit })}

      <Card padding="md">
        <Stack gap="var(--spacing-lg)">
          <Stack gap="var(--spacing-2xs)">
            <SelectField
              label={t('providerPermissions.qwen.mode.label')}
              value={approvalMode}
              onChange={(value) => setApprovalMode(value as QwenApprovalMode)}
              options={modeOptions}
            />
            <Typography variant="caption" color={approvalMode === 'yolo' ? 'warning' : 'subtle'}>
              {t(`providerPermissions.qwen.mode.${approvalMode}.description`)}
            </Typography>
          </Stack>

          <TextField
            label={t('providerPermissions.qwen.allow.label')}
            value={allowText}
            onChange={setAllowText}
            hint={t('providerPermissions.qwen.allow.hint')}
            placeholder={t('providerPermissions.qwen.rulesPlaceholder')}
            multiline
            rows={4}
            isMono
            disabled={readOnly}
          />

          <TextField
            label={t('providerPermissions.qwen.ask.label')}
            value={askText}
            onChange={setAskText}
            hint={t('providerPermissions.qwen.ask.hint')}
            placeholder={t('providerPermissions.qwen.rulesPlaceholder')}
            multiline
            rows={4}
            isMono
            disabled={readOnly}
          />

          <TextField
            label={t('providerPermissions.qwen.deny.label')}
            value={denyText}
            onChange={setDenyText}
            hint={t('providerPermissions.qwen.deny.hint')}
            placeholder={t('providerPermissions.qwen.rulesPlaceholder')}
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
