import { useTranslation } from 'react-i18next';
import type { CoreFailure } from '@entities/CoreTask';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import styles from './FailureNote.module.scss';

interface FailureNoteProps {
  failure: CoreFailure;
}

/**
 * Отказ запроса по виду: что именно не так и что делать. Причины ядра — дословно под заголовком:
 * экран переводит только свои слова (P32).
 */
export function FailureNote({ failure }: FailureNoteProps) {
  const { t } = useTranslation();
  const P = 'coreLaunch.failure';
  let title: string;
  let lines: string[] = [];
  switch (failure.kind) {
    case 'refusal':
      title = t(`${P}.refusal.${failure.code}`);
      break;
    case 'task-refused':
      title = t(`${P}.taskRefused`);
      lines = failure.problems;
      break;
    case 'authority':
      title = t(`${P}.authority`);
      lines = [
        t(`${P}.authorityCode.${failure.code}`, { defaultValue: failure.code }),
        failure.reason,
      ].filter(Boolean);
      break;
    case 'invalid':
      title = t(`${P}.invalid`);
      lines = failure.issues.map((i) => `${i.path}: ${i.message}`);
      break;
    case 'rejected':
      title = t(`${P}.rejected`, { code: failure.code });
      lines = [failure.reason].filter(Boolean);
      break;
    case 'conflict':
      title = t(`${P}.conflict`);
      lines = [failure.reason].filter(Boolean);
      break;
    case 'network':
      title = t(`${P}.network`);
      break;
    default:
      title = t(`${P}.other`, { message: failure.message || String(failure.status ?? '') });
  }
  return (
    <div className={styles.note} role="alert" data-launch-failure={failure.kind}>
      <Stack gap="var(--spacing-3xs)">
        <Typography variant="body-sm" weight="medium" as="p">
          {title}
        </Typography>
        {lines.map((line) => (
          <Typography key={line} variant="caption" color="muted" as="p">
            {line}
          </Typography>
        ))}
      </Stack>
    </div>
  );
}
