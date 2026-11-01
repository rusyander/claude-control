import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SelectField } from '@shared/ui/select-field';
import { Stack } from '@shared/ui/stack';
import { TextField } from '@shared/ui/text-field';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import type { SplitProblem, UnitDraft } from '../../model/launch.types';
import styles from '../rows.module.scss';
import editor from './SplitEditor.module.scss';

interface UnitEditorProps {
  n: number;
  unit: UnitDraft;
  /** Имена остальных частей — то, от чего эта может зависеть. */
  others: string[];
  repoKeys: string[];
  problems: SplitProblem[];
  estimate: { minutes: number | null; tokens: number | null } | null;
  readOnly: boolean;
  canRemove: boolean;
  onRename: (name: string) => void;
  onPatch: (patch: Partial<Omit<UnitDraft, 'key' | 'name'>>) => void;
  onToggleDep: (dep: string) => void;
  onRemove: () => void;
}

/** Одна часть деления: имя, свои пути, зависимости, репозиторий, флаг контракта. */
export function UnitEditor(props: UnitEditorProps) {
  const { unit, others, repoKeys, problems, estimate, readOnly } = props;
  const { t } = useTranslation();
  const P = 'coreLaunch.split';
  const unknown = t('coreLaunch.estimate.unknown');
  const repoOptions = [...new Set([...repoKeys, ...(unit.repo ? [unit.repo] : [])])].map((r) => ({
    value: r,
    label: r,
  }));
  return (
    <div
      className={`${styles.row} ${problems.length > 0 ? styles.rowDanger : ''}`}
      data-split-unit={unit.name || props.n}
    >
      <Stack gap="var(--spacing-xs)">
        <Stack direction="row" gap="var(--spacing-xs)" align="center" justify="between">
          <Typography variant="body-sm" weight="medium" as="span">
            {t(`${P}.unit`, { n: props.n })}
          </Typography>
          {props.canRemove && !readOnly && (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="trash" />}
              aria-label={t(`${P}.remove`)}
              onClick={props.onRemove}
            />
          )}
        </Stack>
        <div className={editor.grid}>
          <TextField
            label={t(`${P}.name`)}
            value={unit.name}
            onChange={props.onRename}
            readOnly={readOnly}
          />
          {repoOptions.length > 0 && (
            <SelectField
              label={t(`${P}.repo`)}
              value={unit.repo ?? ''}
              options={repoOptions}
              onChange={(v) => props.onPatch({ repo: v || null })}
              disabled={readOnly}
            />
          )}
        </div>
        <TextField
          label={t(`${P}.paths`)}
          hint={t(`${P}.pathsHint`)}
          value={unit.ownedPaths}
          onChange={(v) => props.onPatch({ ownedPaths: v })}
          multiline
          rows={3}
          isMono
          readOnly={readOnly}
        />
        {others.length > 0 && (
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="caption" color="muted" as="span">
              {t(`${P}.deps`)}
            </Typography>
            <Stack direction="row" gap="var(--spacing-3xs)" wrap>
              {others.map((dep) => {
                const on = unit.deps.includes(dep);
                return (
                  <Button
                    key={dep}
                    size="sm"
                    variant={on ? 'primary' : 'secondary'}
                    aria-pressed={on}
                    disabled={readOnly}
                    onClick={() => props.onToggleDep(dep)}
                    leftIcon={on ? <Icon name="check" /> : undefined}
                  >
                    {dep}
                  </Button>
                );
              })}
            </Stack>
          </Stack>
        )}
        <Stack direction="row" gap="var(--spacing-xs)" align="center">
          <Toggle
            checked={unit.contract}
            onCheckedChange={(v) => props.onPatch({ contract: v })}
            aria-label={t(`${P}.contract`)}
            disabled={readOnly}
          />
          <Typography variant="body-sm" as="span">
            {t(`${P}.contract`)}
          </Typography>
        </Stack>
        {estimate && (
          <Typography variant="caption" color="muted" as="p">
            {t(`${P}.estimate`, {
              minutes:
                estimate.minutes === null
                  ? unknown
                  : t('coreLaunch.estimate.minutesValue', { value: estimate.minutes }),
              tokens: estimate.tokens === null ? unknown : estimate.tokens.toLocaleString(),
            })}
          </Typography>
        )}
        {problems.map((p) => (
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
      </Stack>
    </div>
  );
}
