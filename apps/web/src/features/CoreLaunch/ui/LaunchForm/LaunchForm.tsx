import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EstimateFields } from '@agentdeck/contracts/core/estimate';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SelectField } from '@shared/ui/select-field';
import { Stack } from '@shared/ui/stack';
import { TextField } from '@shared/ui/text-field';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import { useScenarioListing } from '../../api/launchApi';
import {
  choiceOfValue,
  emptyDraft,
  fieldsOf,
  REPOS_MAX,
  scenarioOptions,
  scenarioValue,
} from '../../model/launchDraft';
import type { DraftProblem, LaunchDraft, RepoDraft } from '../../model/launch.types';
import { LaunchSection } from '../LaunchSection/LaunchSection';
import styles from './LaunchForm.module.scss';

interface LaunchFormProps {
  pending: boolean;
  /** Ответа нет, ключ повтора держится: кнопка говорит «повторить тем же ключом». */
  retrying: boolean;
  onEstimate: (fields: EstimateFields) => void;
}

/**
 * Форма запуска. Черновик живёт здесь, а не на странице: набор текста не перерисовывает экран
 * с дорогами и делением. Наружу уходят только готовые поля оценки — той же схемой, что у ядра.
 */
export function LaunchForm({ pending, retrying, onEstimate }: LaunchFormProps) {
  const { t } = useTranslation();
  const scenarios = useScenarioListing();
  const [draft, setDraft] = useState<LaunchDraft>(emptyDraft);
  const [problems, setProblems] = useState<DraftProblem[]>([]);
  const P = 'coreLaunch.form';

  const set = <K extends keyof LaunchDraft>(key: K, value: LaunchDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const setRepo = (index: number, patch: Partial<RepoDraft>) =>
    set(
      'repos',
      draft.repos.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    );
  const problemOf = (field: DraftProblem['field']): string | undefined => {
    const p = problems.find((x) => x.field === field);
    if (!p) return undefined;
    return t(`${P}.problems.${p.message === 'forge-only' ? 'forge-only' : field}`);
  };

  const submit = () => {
    const got = fieldsOf(draft);
    if (!got.ok) {
      setProblems(got.problems);
      return;
    }
    setProblems([]);
    onEstimate(got.fields);
  };

  return (
    <LaunchSection title={t(`${P}.heading`)} name="form">
      <Stack gap="var(--spacing-sm)" data-core-launch-form>
        <TextField
          label={t(`${P}.title`)}
          hint={t(`${P}.titleHint`)}
          value={draft.title}
          onChange={(v) => set('title', v)}
          error={problemOf('title')}
        />
        <TextField
          label={t(`${P}.request`)}
          hint={t(`${P}.requestHint`)}
          value={draft.request}
          onChange={(v) => set('request', v)}
          multiline
          rows={5}
          error={problemOf('request')}
        />
        <Stack gap="var(--spacing-xs)" data-launch-repos>
          <Typography variant="body-sm" weight="medium" as="span">
            {t(`${P}.repos`)}
          </Typography>
          {draft.repos.map((repo, index) => (
            // Строки репозиториев без своего id: порядок и есть их личность в форме.
            <div className={styles.repoRow} key={index} data-launch-repo={index}>
              <TextField
                label={t(`${P}.repoPath`)}
                value={repo.path}
                onChange={(v) => setRepo(index, { path: v })}
                isMono
              />
              <TextField
                label={t(`${P}.baseRef`)}
                value={repo.baseRef}
                onChange={(v) => setRepo(index, { baseRef: v })}
                isMono
              />
              {draft.repos.length > 1 && (
                <Button
                  variant="ghost"
                  iconOnly
                  icon={<Icon name="trash" />}
                  aria-label={t(`${P}.removeRepo`)}
                  onClick={() =>
                    set(
                      'repos',
                      draft.repos.filter((_, i) => i !== index),
                    )
                  }
                />
              )}
            </div>
          ))}
          {/* Подсказка базы — одна под списком: у поля в строке она сдвигала бы поля по высоте. */}
          <Typography variant="caption" color="muted" as="p">
            {t(`${P}.baseRefHint`)}
          </Typography>
          {problemOf('repos') && (
            <Typography variant="caption" color="danger" as="p">
              {problemOf('repos')}
            </Typography>
          )}
          {draft.repos.length < REPOS_MAX && (
            <div>
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<Icon name="plus" />}
                onClick={() => set('repos', [...draft.repos, { path: '', baseRef: '' }])}
              >
                {t(`${P}.addRepo`)}
              </Button>
            </div>
          )}
        </Stack>
        <SelectField
          label={t(`${P}.scenario`)}
          hint={scenarios.isError ? t(`${P}.scenariosUnread`) : t(`${P}.scenarioHint`)}
          value={scenarioValue(draft.scenario)}
          options={scenarioOptions(scenarios.data)}
          onChange={(v) => {
            const choice = choiceOfValue(v);
            if (choice) set('scenario', choice);
          }}
        />
        {problemOf('scenario') && (
          <Typography variant="caption" color="danger" as="p">
            {problemOf('scenario')}
          </Typography>
        )}
        <Stack
          direction="row"
          gap="var(--spacing-sm)"
          align="start"
          data-ci-wait={draft.ciWait ? 'on' : 'off'}
        >
          <Toggle
            checked={draft.ciWait}
            onCheckedChange={(v) => set('ciWait', v)}
            aria-label={t(`${P}.ciWait`)}
          />
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body-sm" weight="medium" as="span">
              {t(`${P}.ciWait`)}
            </Typography>
            <Typography variant="caption" color="muted" as="span">
              {t(`${P}.ciWaitHint`)}
            </Typography>
          </Stack>
        </Stack>
        <div>
          <Button onClick={submit} isLoading={pending} data-estimate-button>
            {retrying ? t(`${P}.retry`) : t(`${P}.estimate`)}
          </Button>
        </div>
      </Stack>
    </LaunchSection>
  );
}
