import type { DescribedPathStepProposal, LocalizedLine } from '@agentdeck/contracts';
import { useTranslation } from 'react-i18next';
import { pickLang } from '../../../lib/pickLang';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import styles from './AssistantTurn.module.scss';
import { Icon } from '@shared/ui/icon';

export function AssistantTurn({ proposal }: { proposal: DescribedPathStepProposal }) {
  const { t, i18n } = useTranslation();
  // Что делает найденный ресурс — на языке интерфейса, из описания сервера;
  // своими словами модели — только когда описания ещё нет.
  const why = (item: { why: string; summary?: LocalizedLine }): string =>
    item.summary ? pickLang(item.summary, i18n.language) : item.why;
  const typeLabel = (type: string): string => t(`groupPath.resource_${type}`);
  // Решать нечего — всё равно говорим словами, иначе ход ассистента — пустой пузырь.
  const isQuiet =
    !proposal.match && proposal.similar.length === 0 && proposal.questions.length === 0;

  return (
    <Stack gap="var(--spacing-2xs)">
      {isQuiet && (
        <Typography variant="body-sm" className={styles.text}>
          {t('groupPath.composer.ready')}
        </Typography>
      )}
      {proposal.match && (
        <Typography variant="body-sm" color="success" className={styles.text}>
          {t('groupPath.composer.match', {
            type: typeLabel(proposal.match.type),
            id: proposal.match.id,
            why: why(proposal.match),
          })}
        </Typography>
      )}
      {/* Ключи с номером: список пишет модель, и два одинаковых пункта — не редкость. */}
      {proposal.similar.map((item, index) => (
        <Stack key={`${item.type}:${item.id}:${index}`} direction="row" gap="var(--spacing-2xs)">
          <Icon name="warning" size={16} />
          <Typography variant="body-sm" color="warning" className={styles.text}>
            {t('groupPath.composer.similar', {
              type: typeLabel(item.type),
              id: item.id,
              why: why(item),
            })}
          </Typography>
        </Stack>
      ))}
      {proposal.questions.length > 0 && (
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body-sm" weight="medium">
            {t('groupPath.composer.questions')}
          </Typography>
          <ol className={styles.questions}>
            {proposal.questions.map((question, index) => (
              <li key={`${index}:${question}`}>
                <Typography variant="body-sm" as="span">
                  {question}
                </Typography>
              </li>
            ))}
          </ol>
        </Stack>
      )}
    </Stack>
  );
}
