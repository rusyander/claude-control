import { useTranslation } from 'react-i18next';
import type { BadgeTone } from '@shared/ui/badge';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import type { SplitProposal, UnitDraft } from '../../model/launch.types';
import {
  addUnit,
  patchUnit,
  removeUnit,
  renameUnit,
  splitProblems,
  toggleDep,
  UNITS_MAX,
} from '../../model/splitDraft';
import { LaunchSection } from '../LaunchSection/LaunchSection';
import { UnitEditor } from './UnitEditor';

const DECIDED_TONE: Record<NonNullable<SplitProposal['decided']> | 'pending', BadgeTone> = {
  accepted: 'success',
  approved: 'success',
  edited: 'success',
  refused: 'danger',
  pending: 'info',
};

interface SplitEditorProps {
  split: SplitProposal | null;
  units: UnitDraft[] | null;
  repoKeys: string[];
  dirty: boolean;
  saving: boolean;
  /** Задача запущена или отказана — деление только для чтения. */
  readOnly: boolean;
  onChange: (units: UnitDraft[]) => void;
  onSave: () => void;
  onReset: () => void;
}

/**
 * Деление на части (02:69): предложение плана (или ядра) → правка человека → `edit-split`.
 * Пересечение путей и цикл судит ядро той же проверкой, что у плана; здесь — только то, что
 * видно без него. Сохранённая правка приходит обратно новым предложением в ленте.
 */
export function SplitEditor(props: SplitEditorProps) {
  const { split, units, readOnly } = props;
  const { t } = useTranslation();
  const P = 'coreLaunch.split';
  if (!split || !units) {
    return (
      <LaunchSection title={t(`${P}.heading`)} name="split">
        <Typography variant="caption" color="muted" as="p" data-split-waiting>
          {t(`${P}.waiting`)}
        </Typography>
      </LaunchSection>
    );
  }
  const problems = splitProblems(units);
  const general = problems.filter((p) => p.unitKey === null);
  const estimateOf = (name: string) => split.units.find((u) => u.name === name)?.estimate ?? null;
  const decided = split.decided ?? 'pending';
  return (
    <LaunchSection title={t(`${P}.heading`)} name="split">
      <Stack gap="var(--spacing-sm)" data-split-id={split.splitId} data-split-decided={decided}>
        <Stack direction="row" gap="var(--spacing-xs)" wrap>
          <Badge tone="neutral">{t(`${P}.by.${split.by}`)}</Badge>
          <Badge tone={DECIDED_TONE[decided]} withDot>
            {t(`${P}.decided.${decided}`)}
          </Badge>
        </Stack>
        {units.map((unit, i) => (
          <UnitEditor
            key={unit.key}
            n={i + 1}
            unit={unit}
            others={units
              .filter((u) => u.key !== unit.key && u.name.trim())
              .map((u) => u.name.trim())}
            repoKeys={props.repoKeys}
            problems={problems.filter((p) => p.unitKey === unit.key)}
            estimate={estimateOf(unit.name)}
            readOnly={readOnly}
            canRemove={units.length > 1}
            onRename={(name) => props.onChange(renameUnit(units, unit.key, name))}
            onPatch={(patch) => props.onChange(patchUnit(units, unit.key, patch))}
            onToggleDep={(dep) => props.onChange(toggleDep(units, unit.key, dep))}
            onRemove={() => props.onChange(removeUnit(units, unit.key))}
          />
        ))}
        {general.map((p) => (
          <Typography
            key={p.code}
            variant="caption"
            color="danger"
            as="p"
            data-split-problem={p.code}
          >
            {t(`${P}.problem.${p.code}`)}
          </Typography>
        ))}
        {!readOnly && (
          <Stack direction="row" gap="var(--spacing-xs)" wrap>
            {units.length < UNITS_MAX && (
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Icon name="plus" />}
                onClick={() => props.onChange(addUnit(units, props.repoKeys[0] ?? null))}
              >
                {t(`${P}.add`)}
              </Button>
            )}
            <Button
              size="sm"
              onClick={props.onSave}
              disabled={!props.dirty || problems.length > 0}
              isLoading={props.saving}
              data-split-save
            >
              {t(`${P}.save`)}
            </Button>
            {props.dirty && (
              <Button size="sm" variant="ghost" onClick={props.onReset}>
                {t(`${P}.reset`)}
              </Button>
            )}
          </Stack>
        )}
      </Stack>
    </LaunchSection>
  );
}
