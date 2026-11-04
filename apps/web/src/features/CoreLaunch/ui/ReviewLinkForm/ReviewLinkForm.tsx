import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReviewLinkRefused } from '@agentdeck/contracts/core/review-link';
import { Button } from '@shared/ui/button';
import { Stack } from '@shared/ui/stack';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import {
  emptyReviewLinkDraft,
  reviewLinkFieldsOf,
  type ReviewLinkFields,
  type ReviewLinkProblem,
} from '../../model/reviewLinkDraft';
import type { ReviewLinkDraft } from '../../model/reviewLink.types';
import { LaunchSection } from '../LaunchSection/LaunchSection';
import styles from './ReviewLinkForm.module.scss';

interface ReviewLinkFormProps {
  pending: boolean;
  /** Ответа нет, ключ повтора держится: кнопка говорит «повторить тем же ключом». */
  retrying: boolean;
  refusal: ReviewLinkRefused | null;
  onOpen: (fields: ReviewLinkFields) => void;
}

/**
 * Ревью MR по ссылке (этап 10, F8) — перенос карточки ревью старой панели на ядро: ссылка и
 * репозиторий → задача `review-link@1`; дальше тот же ход экрана, что после оценки (дороги,
 * гранты, запуск). Решение по замечаниям и пуш — вопросы задачи в её ленте, не здесь.
 */
export function ReviewLinkForm({ pending, retrying, refusal, onOpen }: ReviewLinkFormProps) {
  const { t, i18n } = useTranslation();
  const [draft, setDraft] = useState<ReviewLinkDraft>(emptyReviewLinkDraft);
  const [problems, setProblems] = useState<ReviewLinkProblem[]>([]);
  const P = 'coreLaunch.reviewLink';
  const problemOf = (field: ReviewLinkProblem): string | undefined =>
    problems.includes(field) ? t(`${P}.problems.${field}`) : undefined;

  const submit = () => {
    const got = reviewLinkFieldsOf(draft, i18n.language);
    if (!got.ok) {
      setProblems(got.problems);
      return;
    }
    setProblems([]);
    onOpen(got.fields);
  };

  return (
    <LaunchSection title={t(`${P}.heading`)} hint={t(`${P}.hint`)} name="review-link">
      <Stack gap="var(--spacing-sm)" data-review-link-form>
        <TextField
          label={t(`${P}.url`)}
          hint={t(`${P}.urlHint`)}
          value={draft.url}
          onChange={(v) => setDraft((d) => ({ ...d, url: v }))}
          error={problemOf('url')}
          isMono
        />
        <TextField
          label={t(`${P}.repo`)}
          hint={t(`${P}.repoHint`)}
          value={draft.repo}
          onChange={(v) => setDraft((d) => ({ ...d, repo: v }))}
          error={problemOf('repo')}
          isMono
        />
        {refusal && (
          <div className={styles.refusal} role="alert" data-review-link-refusal={refusal.code}>
            <Stack gap="var(--spacing-3xs)">
              <Typography variant="body-sm" weight="medium" as="p">
                {t(`${P}.refusal.${refusal.code}`)}
              </Typography>
              {refusal.problems.map((line) => (
                <Typography key={line} variant="caption" color="muted" as="p">
                  {line}
                </Typography>
              ))}
            </Stack>
          </div>
        )}
        <div>
          <Button onClick={submit} isLoading={pending} data-review-link-button>
            {retrying ? t(`${P}.retry`) : t(`${P}.open`)}
          </Button>
        </div>
      </Stack>
    </LaunchSection>
  );
}
