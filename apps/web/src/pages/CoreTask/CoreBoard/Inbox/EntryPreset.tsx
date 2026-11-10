import { useTranslation } from 'react-i18next';
import type { BoardCard } from '@agentdeck/contracts/core/board';
import { SelectField } from '@shared/ui/select-field';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { canSetPreset, presetChoices, presetRefusalOf } from './entryPreset.lib';
import { useSetEntryPreset } from './inboxApi';

const P = 'coreInbox.entryPreset';

/**
 * Пресет записи во «Входящих» и очереди (W2-D, P164): сменить можно до старта — ровно когда ядро
 * разрешило ход `set-preset`. Отказ ядра (недостающая предпосылка) — его причиной под выбором;
 * запись остаётся с прежним пресетом.
 */
export function EntryPreset({ card }: { card: BoardCard }) {
  const { t } = useTranslation();
  const change = useSetEntryPreset();
  if (!canSetPreset(card)) return null;
  const entryId = card.entryId ?? card.id;
  const current = change.isPending ? change.variables.preset : (card.preset ?? '');
  const label = (id: string): string => t(`${P}.presets.${id}`, { defaultValue: id });
  // Проза ядра английская (контракт): под выбором — своя строка, проза — подсказкой.
  const refusal = change.isError ? presetRefusalOf(change.error) : undefined;

  return (
    <Stack gap="var(--spacing-2xs)" data-entry-preset={card.preset ?? ''}>
      <SelectField
        label={t(`${P}.label`)}
        hint={t(`${P}.hint`)}
        value={current}
        disabled={change.isPending}
        onChange={(preset) => {
          if (preset !== card.preset) change.mutate({ entryId, preset });
        }}
        options={presetChoices(card.preset).map((id) => ({ value: id, label: label(id) }))}
      />
      {refusal && (
        <Typography
          variant="caption"
          color="danger"
          as="p"
          title={refusal.raw}
          data-entry-preset-error
        >
          {t(`${P}.refused`, {
            reason: t(`${P}.refusals.${refusal.key}`, {
              ...refusal.values,
              preset: refusal.values.preset ? label(refusal.values.preset) : '',
            }),
          })}
        </Typography>
      )}
    </Stack>
  );
}
