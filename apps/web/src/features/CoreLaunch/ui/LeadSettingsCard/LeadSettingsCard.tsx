import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LEAD_PROFILES, type LeadSettingsPatch } from '@agentdeck/contracts/core/lead';
import { failureOf } from '@entities/CoreTask';
import { Button } from '@shared/ui/button';
import { Card } from '@shared/ui/card';
import { SelectField } from '@shared/ui/select-field';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { useCoreConfig } from '../../api/launchApi';
import { useSaveLead } from '../../api/leadSettingsApi';
import {
  effectiveWith,
  leadChanged,
  MACHINE_SCOPE,
  patchOf,
  patchProblems,
  scopeKeys,
  sessionSlotsOf,
  withProfile,
  type LeadScope,
} from '../../model/leadSettings';
import { FailureNote } from '../FailureNote/FailureNote';
import { LeadAdvanced } from './LeadAdvanced';
import { LearnedReset } from './LearnedReset';
import styles from './LeadSettingsCard.module.scss';

export interface LeadSettingsCardProps {
  /** Область правки: `''` — умолчания машины, иначе ключ репозитория. */
  scope: LeadScope;
  onScope: (scope: LeadScope) => void;
  /** Проекты, которые экран уже видел (ключ из ленты оцененной задачи). */
  seen: readonly string[];
}

/**
 * Настройки ведения (этап 11, D11, W3-16): профиль и подробности уровня — машины или проекта.
 * Значения на экране — действующие (резолвер ядра поверх черновика), запись — правка уровня одной
 * `set-config`. Черновик заново из настройки, когда меняется записанная правка области или сама
 * область: правки не копятся поверх чужой записи, а 409 говорит, что настройку изменили.
 */
export function LeadSettingsCard({ scope, onScope, seen }: LeadSettingsCardProps) {
  const { t } = useTranslation();
  const P = 'coreLaunch.lead';
  const config = useCoreConfig();
  const save = useSaveLead();
  const view = config.data;
  // Первый кадр — уже записанная правка области, а не пустая (иначе мелькнул бы чужой профиль).
  const [patch, setPatch] = useState<LeadSettingsPatch>(() => patchOf(view, scope));
  const [advanced, setAdvanced] = useState(false);
  // Черновик сбрасывает только смена записанной правки ЭТОЙ области (или самой области), а не
  // любое новое чтение настройки: запись выбора MCP соседней карточкой перечитывает ту же
  // настройку и иначе стирала бы несохранённый профиль ведения.
  const stored = JSON.stringify(patchOf(view, scope));
  useEffect(() => {
    setPatch(JSON.parse(stored) as LeadSettingsPatch);
  }, [stored, scope]);
  // Итог записи относится к области, где нажали «Сохранить»: другая область — итога нет.
  const resetSave = save.reset;
  useEffect(() => {
    resetSave();
  }, [scope, resetSave]);
  // Правка после записи: «Сохранено» уже не про то, что на экране, — итог снимается. Отказ
  // остаётся: причину человек читает, пока правит.
  const edit = (fn: (p: LeadSettingsPatch) => LeadSettingsPatch) => {
    if (save.isSuccess) resetSave();
    setPatch(fn);
  };

  const effective = useMemo(() => effectiveWith(view, scope, patch), [view, scope, patch]);
  const problems = patchProblems(patch);
  const changed = leadChanged(view, scope, patch);
  const scopes = scopeKeys(view, seen);
  const options = [
    { value: MACHINE_SCOPE, label: t(`${P}.scopeMachine`) },
    ...scopes.map((key) => ({ value: key, label: t(`${P}.scopeProject`, { key }) })),
  ];

  return (
    <Card padding="md" data-lead-settings data-lead-scope-value={scope || 'machine'}>
      <Stack gap="var(--spacing-sm)">
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="heading-sm" as="h3">
            {t(`${P}.heading`)}
          </Typography>
          <Typography variant="caption" color="muted" as="p">
            {t(`${P}.hint`)}
          </Typography>
        </Stack>
        {config.isError && (
          <Typography variant="caption" color="danger" as="p" data-lead-config-error>
            {t(`${P}.configError`)}
          </Typography>
        )}
        <div data-lead-scope className={styles.scope}>
          <SelectField label={t(`${P}.scope`)} value={scope} options={options} onChange={onScope} />
        </div>
        <fieldset className={styles.profiles} data-lead-profiles>
          <legend className={styles.legend}>{t(`${P}.profile`)}</legend>
          {LEAD_PROFILES.map((profile) => (
            <label key={profile} className={styles.profile}>
              <input
                type="radio"
                name="lead-profile"
                value={profile}
                checked={effective.settings.profile === profile}
                disabled={!view}
                onChange={() => edit((p) => withProfile(p, profile))}
                // Нажатие на уже отмеченный (унаследованный) профиль change не даёт, а закрепить
                // его за областью человек вправе: click пишет профиль и тогда.
                onClick={() => edit((p) => withProfile(p, profile))}
                data-lead-profile={profile}
              />
              <span className={styles.profileText}>
                <Typography variant="body-sm" weight="medium" as="span">
                  {t(`${P}.profiles.${profile}`)}
                </Typography>
                <Typography variant="caption" color="muted" as="span">
                  {t(`${P}.profileHint.${profile}`)}
                </Typography>
              </span>
            </label>
          ))}
          <Typography variant="caption" color="muted" as="p" data-lead-profile-source>
            {t(`${P}.fromSource.${effective.sources.profile}`)}
          </Typography>
        </fieldset>
        <div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setAdvanced((a) => !a)}
            aria-expanded={advanced}
            data-lead-advanced
          >
            {advanced ? t(`${P}.advancedHide`) : t(`${P}.advanced`)}
          </Button>
        </div>
        {advanced && (
          <LeadAdvanced
            patch={patch}
            effective={effective}
            cap={sessionSlotsOf(view)}
            scope={scope}
            disabled={!view || save.isPending}
            onPatch={(next) => edit(() => next)}
          />
        )}
        {problems.length > 0 && (
          <Typography variant="caption" color="danger" as="p" data-lead-problems>
            {t(`${P}.problems`, { paths: problems.join(', ') })}
          </Typography>
        )}
        <Stack direction="row" gap="var(--spacing-xs)" wrap>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              if (view) save.mutate({ view, scope, patch });
            }}
            disabled={!view || !changed || problems.length > 0}
            isLoading={save.isPending}
            data-lead-save
          >
            {t(`${P}.save`)}
          </Button>
          {changed && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPatch(patchOf(view, scope))}
              disabled={save.isPending}
              data-lead-reset
            >
              {t(`${P}.reset`)}
            </Button>
          )}
        </Stack>
        {save.isSuccess && !save.isPending && (
          <Typography variant="caption" color="success" as="p" role="status" data-lead-saved>
            {t(`${P}.saved`)}
          </Typography>
        )}
        {save.isError && (
          <div data-lead-refused>
            <FailureNote failure={failureOf(save.error)} />
          </div>
        )}
        <LearnedReset project={scope} />
      </Stack>
    </Card>
  );
}
