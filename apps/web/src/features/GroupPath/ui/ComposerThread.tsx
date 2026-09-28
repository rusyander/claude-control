import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { DescribedPathStepProposal, LocalizedLine } from '@agentdeck/contracts';
import { pickLang } from '../model/useEntryTitle';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { SentImageNames } from '@shared/ui/image-attach';
import type { ComposerThreadProps } from './ComposerThread.types';
import styles from './ComposerThread.module.scss';

/**
 * Лента разговора с ассистентом шага. От ассистента показываем не текст, а то,
 * что человеку надо решить: вопросы, «уже есть ресурс, который делает ровно
 * это», похожие ресурсы. Сам итоговый шаг — ниже, в редакторе.
 */
export function ComposerThread({ turns, isThinking }: ComposerThreadProps) {
  const { t } = useTranslation();
  const boxRef = useRef<HTMLDivElement>(null);
  // Лента ограничена по высоте: новый ход должен быть виден, а не прятаться
  // под краем прокрутки — иначе ответ ассистента выглядит пустым пузырём.
  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [turns.length, isThinking]);
  if (turns.length === 0 && !isThinking) return null;

  return (
    <div
      ref={boxRef}
      className={styles.thread}
      role="log"
      aria-live="polite"
      aria-label={t('groupPath.composer.threadLabel')}
      // Прокручиваемая область должна быть досягаема с клавиатуры.
      tabIndex={0}
    >
      <Stack gap="var(--spacing-xs)">
        {turns.map((turn) =>
          turn.role === 'user' ? (
            <div key={turn.id} className={`${styles.turn} ${styles.user}`}>
              <Typography variant="caption" color="subtle">
                {t('groupPath.composer.you')}
              </Typography>
              <Typography variant="body-sm" className={styles.text}>
                {turn.text ?? ''}
              </Typography>
              {turn.images && <SentImageNames names={turn.images} />}
            </div>
          ) : (
            <div key={turn.id} className={`${styles.turn} ${styles.assistant}`}>
              <Typography variant="caption" color="subtle">
                {t('groupPath.composer.assistant')}
              </Typography>
              {turn.proposal && <AssistantTurn proposal={turn.proposal} />}
            </div>
          ),
        )}
        {isThinking && (
          <Typography variant="body-sm" color="subtle" aria-busy="true">
            {t('groupPath.composer.thinking')}
          </Typography>
        )}
      </Stack>
    </div>
  );
}

function AssistantTurn({ proposal }: { proposal: DescribedPathStepProposal }) {
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
