import { useTranslation } from 'react-i18next';
import {
  SPLIT_TICKET_DUPLICATE_CHOICES,
  type SplitTicketDuplicate,
  type SplitTicketDuplicateChoice,
  type SplitTicketDuplicateDecision,
} from '@agentdeck/contracts/split-ticket-batch';
import { SelectField } from '@shared/ui/select-field';
import { Typography } from '@shared/ui/typography';
import type { SplitTicketDuplicatesProps } from './SplitTicketResolve.types';
import styles from './SplitTicketResolve.module.scss';
import { messageFromPayload } from '../../../../shared/api/client';

const base = 'chat.cascade.hub.tickets.resolve';

/** Решение по умолчанию — связать: копия открытой задачи хуже комментария в неё. */
export const DEFAULT_DUPLICATE_CHOICE: SplitTicketDuplicateChoice = 'link';

/** Первая находка дефекта — ключ, по которому окно хранит и шлёт решение. */
export const duplicateProposal = (duplicate: SplitTicketDuplicate): string =>
  duplicate.proposals[0] ?? '';

/**
 * Решения, которые уйдут с публикацией: по одному на каждую показанную похожую
 * задачу, с её ключом; не тронутая человеком строка — «связать».
 */
export function duplicateDecisions(
  duplicates: readonly SplitTicketDuplicate[],
  choices: Readonly<Record<string, SplitTicketDuplicateChoice>>,
): SplitTicketDuplicateDecision[] {
  return duplicates.map((duplicate) => ({
    proposal: duplicateProposal(duplicate),
    choice: choices[duplicateProposal(duplicate)] ?? DEFAULT_DUPLICATE_CHOICE,
    issueKey: duplicate.issue.key,
  }));
}

function DuplicateRow({
  duplicate,
  choice,
  onChoice,
}: {
  duplicate: SplitTicketDuplicate;
  choice: SplitTicketDuplicateChoice;
  onChoice: SplitTicketDuplicatesProps['onChoice'];
}) {
  const { t } = useTranslation();
  const proposal = duplicateProposal(duplicate);
  return (
    <li
      className={`${styles.item} ${styles.bundle}`}
      data-resolve-similar={duplicate.issue.key}
      data-resolve-similar-choice={choice}
    >
      <Typography variant="body-sm" as="div" className={styles.wide}>
        {duplicate.title}
      </Typography>
      <Typography variant="caption" color="subtle" as="div" className={styles.wide}>
        <a href={duplicate.issue.url} target="_blank" rel="noreferrer" className={styles.key}>
          {duplicate.issue.key}
        </a>{' '}
        {duplicate.issue.summary} — {t(`${base}.dupReason.${duplicate.reason}`)}
      </Typography>
      <SelectField
        label={t(`${base}.dupChoiceLabel`)}
        value={choice}
        onChange={(value) => onChoice(proposal, value as SplitTicketDuplicateChoice)}
        options={SPLIT_TICKET_DUPLICATE_CHOICES.map((value) => ({
          value,
          label: t(`${base}.dupChoice.${value}`, { key: duplicate.issue.key }),
        }))}
      />
    </li>
  );
}

/**
 * Проверка на повторы до публикации (владелец 25.10.2026): похожие открытые
 * задачи Jira — по строке на дефект, ссылка на задачу, почему похожа, и выбор
 * человека: связать (комментарий в неё), пропустить или завести новую.
 */
export function SplitTicketDuplicates({
  duplicates,
  choices,
  onChoice,
}: SplitTicketDuplicatesProps) {
  const { t } = useTranslation();
  if (duplicates.state === 'loading') {
    return (
      <Typography variant="caption" color="subtle" as="div" data-resolve-similar-loading>
        {t(`${base}.dupChecking`)}
      </Typography>
    );
  }
  const { data } = duplicates.state === 'ready' ? duplicates : { data: undefined };
  if (duplicates.state === 'error' || data?.failed) {
    const message =
      duplicates.state === 'error'
        ? duplicates.message
        : (messageFromPayload(data ?? {}) ?? data?.message ?? '');
    return (
      <Typography variant="caption" color="warning" as="div" data-resolve-similar-failed>
        {t(`${base}.dupFailed`, { message })}
      </Typography>
    );
  }
  const found = data?.duplicates ?? [];
  if (found.length === 0) {
    return (
      <Typography variant="caption" color="subtle" as="div" data-resolve-similar-none>
        {t(`${base}.dupNone`)}
      </Typography>
    );
  }
  return (
    <div className={styles.section} data-resolve-similar-list={found.length}>
      <Typography variant="body-sm" color="warning" as="div">
        {t(`${base}.dupTitle`, { count: found.length })}
      </Typography>
      <ul className={styles.list}>
        {found.map((duplicate) => (
          <DuplicateRow
            key={duplicateProposal(duplicate)}
            duplicate={duplicate}
            choice={choices[duplicateProposal(duplicate)] ?? DEFAULT_DUPLICATE_CHOICE}
            onChoice={onChoice}
          />
        ))}
      </ul>
    </div>
  );
}
