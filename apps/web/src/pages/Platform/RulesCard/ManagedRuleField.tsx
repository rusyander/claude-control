import { useTranslation } from 'react-i18next';
import { platformThinkingModes } from '@agentdeck/contracts';
import type { Platform, PlatformRuleRow, PlatformThinkingMode } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { parseToolNames, platformRules, withRule } from '../lib/rulesView';
import type { RuleDrafts } from './useRuleDrafts';
import { serverFieldText } from '@shared/config/i18n';

interface ManagedRuleFieldProps {
  row: PlatformRuleRow;
  platform: Platform;
  drafts: RuleDrafts;
  /**
   * Набор контура не добавить, пока включена прослойка (взаимное исключение
   * считает `RulesCard`: вторая его половина запирает выключатель прослойки).
   */
  toolsLocked: boolean;
  update: (next: Platform) => void;
}

/** Ручка одного правила, которым панель распоряжается, — по полю запроса. */
export function ManagedRuleField({
  row,
  platform,
  drafts,
  toolsLocked,
  update,
}: ManagedRuleFieldProps) {
  const { t } = useTranslation();
  const current = platformRules(platform);

  if (row.field === 'platformTools') {
    return (
      <Stack gap="var(--spacing-3xs)">
        <Stack direction="row" align="end" gap="var(--spacing-xs)" wrap>
          <TextField
            label={serverFieldText(row, 'title')}
            value={drafts.tools}
            onChange={drafts.setTools}
            placeholder={t('platform.rulesToolsPlaceholder')}
            // Причина запрета живёт в подсказке поля, а не отдельной строкой
            // под ним: запертое поле выброшено из обхода табом, и человек с
            // клавиатуры до объяснения не доходил вовсе (ревью Т7, m3).
            hint={toolsLocked ? t('platform.rulesToolsBlocked') : serverFieldText(row, 'detail')}
            disabled={toolsLocked}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={!drafts.toolsChanged || toolsLocked}
            onClick={() =>
              update(withRule(platform, 'platformTools', parseToolNames(drafts.tools)))
            }
          >
            {t('platform.rulesApply')}
          </Button>
        </Stack>
      </Stack>
    );
  }

  if (row.field === 'toolMode') {
    // Остаётся доступным и при пустом списке инструментов, хотя тогда никуда
    // не отправляется (об этом — подсказка ниже): режим выбирают ДО того, как
    // впишут имена, и запертый селект заставлял бы возвращаться сюда вторым
    // заходом. Ревью Т7 (m7) предлагало запереть — решено оставить.
    return (
      <SelectField
        label={serverFieldText(row, 'title')}
        value={current.toolMode}
        onChange={(value) =>
          update(withRule(platform, 'toolMode', value as Platform['rules']['platform']['toolMode']))
        }
        options={(row.options ?? []).map((option) => ({
          value: option,
          label: t(`platform.rulesToolMode.${option}`, { defaultValue: option }),
        }))}
        hint={
          current.platformTools.length === 0
            ? t('platform.rulesModeIdle')
            : serverFieldText(row, 'detail')
        }
      />
    );
  }

  if (row.field === 'generationPreset') {
    return (
      <Stack direction="row" align="end" gap="var(--spacing-xs)" wrap>
        <TextField
          label={serverFieldText(row, 'title')}
          value={drafts.preset}
          onChange={drafts.setPreset}
          placeholder={t('platform.rulesPresetPlaceholder')}
          hint={serverFieldText(row, 'detail')}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!drafts.presetChanged}
          onClick={() => update(withRule(platform, 'generationPreset', drafts.preset.trim()))}
        >
          {t('platform.rulesApply')}
        </Button>
      </Stack>
    );
  }

  // Три состояния, а не выключатель: «не отправлять» и «выключить» у
  // reasoning-модели различаются — думать по умолчанию она может сама.
  if (row.field === 'enableThinking') {
    return (
      <SelectField
        label={serverFieldText(row, 'title')}
        value={current.enableThinking}
        onChange={(value) =>
          update(withRule(platform, 'enableThinking', value as PlatformThinkingMode))
        }
        options={platformThinkingModes.map((mode) => ({
          value: mode,
          label: t(`platform.rulesThinkingMode.${mode}`),
        }))}
        hint={serverFieldText(row, 'detail')}
      />
    );
  }

  // Правило, объявленное задаваемым, но панелью ещё не нарисованное. Раньше
  // сюда падала ветка по умолчанию и рисовала ЧУЖОЙ тумблер: новое булево
  // правило манифеста показывало бы значение `enableThinking` и писало бы его
  // же (ревью Т7, m8). Честнее показать значение и сказать, что ручки нет.
  return (
    <Stack gap="var(--spacing-3xs)">
      <Typography variant="body-sm" as="span">
        {serverFieldText(row, 'title')}
      </Typography>
      <Typography variant="caption" color="muted" as="span">
        {t('platform.rulesUnsupported', { value: serverFieldText(row, 'value') || '—' })}
      </Typography>
    </Stack>
  );
}
