import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { learnedKeySchema, type LearnedResetBody } from '@agentdeck/contracts/core/commands';
import { LEAD_ROLES } from '@agentdeck/contracts/core/lead';
import { SESSION_STEP_KINDS } from '@agentdeck/contracts/core/model-tools';
import { failureOf } from '@entities/CoreTask';
import { Button } from '@shared/ui/button';
import { SelectField } from '@shared/ui/select-field';
import { Stack } from '@shared/ui/stack';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { useLearnedReset } from '../../api/leadSettingsApi';
import { FailureNote } from '../FailureNote/FailureNote';
import styles from './LeadSettingsCard.module.scss';

interface KeyDraft {
  project: string;
  stepKind: string;
  adapter: string;
  route: string;
  model: string;
  role: string;
}

const DEFAULT_STEP = 'work';

/** Ключ обучения из полей формы; негоден схемой ядра — `null` (кнопка не активна). */
export function learnedKeyOf(draft: KeyDraft): LearnedResetBody['key'] | null {
  const candidate = {
    project: draft.project.trim(),
    stepKind: draft.stepKind,
    adapter: draft.adapter.trim(),
    route: draft.route.trim(),
    model: draft.model.trim() || null,
    ...(draft.role ? { role: draft.role } : {}),
  };
  const parsed = learnedKeySchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Сброс ключа обучения (P140): только человек. Ключ — проект, вид шага, CLI, маршрут, модель и
 * роль; поле «Проект» начинается с проекта выбранной области. Отказ ядра — дословно.
 */
export function LearnedReset({ project }: { project: string }) {
  const { t } = useTranslation();
  const P = 'coreLaunch.lead.learned';
  const reset = useLearnedReset();
  const [draft, setDraft] = useState<KeyDraft>({
    project,
    stepKind: DEFAULT_STEP,
    adapter: '',
    route: '',
    model: '',
    role: '',
  });
  useEffect(() => {
    if (project) setDraft((d) => ({ ...d, project }));
  }, [project]);
  const set = (field: keyof KeyDraft) => (value: string) =>
    setDraft((d) => ({ ...d, [field]: value }));
  const key = learnedKeyOf(draft);
  return (
    <fieldset className={styles.group} data-learned-reset>
      <legend className={styles.legend}>{t(`${P}.heading`)}</legend>
      <Stack gap="var(--spacing-sm)">
        <Typography variant="caption" color="muted" as="p">
          {t(`${P}.hint`)}
        </Typography>
        <div className={styles.resetGrid}>
          <TextField
            label={t(`${P}.project`)}
            value={draft.project}
            onChange={set('project')}
            isMono
          />
          <SelectField
            label={t(`${P}.stepKind`)}
            value={draft.stepKind}
            options={SESSION_STEP_KINDS.map((k) => ({ value: k, label: k }))}
            onChange={set('stepKind')}
          />
          <TextField
            label={t(`${P}.adapter`)}
            value={draft.adapter}
            onChange={set('adapter')}
            isMono
          />
          <TextField label={t(`${P}.route`)} value={draft.route} onChange={set('route')} isMono />
          <TextField
            label={t(`${P}.model`)}
            hint={t(`${P}.modelHint`)}
            value={draft.model}
            onChange={set('model')}
            isMono
          />
          <SelectField
            label={t(`${P}.role`)}
            value={draft.role}
            options={[
              { value: '', label: t(`${P}.roleDefault`) },
              ...LEAD_ROLES.map((r) => ({ value: r, label: t(`coreLaunch.lead.role.${r}`) })),
            ]}
            onChange={set('role')}
          />
        </div>
        <div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              if (key) reset.mutate(key);
            }}
            disabled={!key}
            isLoading={reset.isPending}
            data-learned-reset-submit
          >
            {t(`${P}.submit`)}
          </Button>
        </div>
        {reset.isSuccess && !reset.isPending && (
          <Typography
            variant="caption"
            color="success"
            as="p"
            role="status"
            data-learned-reset-done
          >
            {t(`${P}.done`, { key: reset.data.key })}
          </Typography>
        )}
        {reset.isError && (
          <div data-learned-reset-refused>
            <FailureNote failure={failureOf(reset.error)} />
          </div>
        )}
      </Stack>
    </fieldset>
  );
}
