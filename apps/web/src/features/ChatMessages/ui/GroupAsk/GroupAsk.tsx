import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { ChildQuestionBody } from '../ChildQuestionBody/ChildQuestionBody';
import type { GroupAskProps } from './GroupAsk.types';
import styles from './GroupAsk.module.scss';

/**
 * Вопрос агента группы — островком в её карточке (владелец, карточка 27
 * прогона 20.10): своим цветом, с подписью, что спрашивает агент, на какой
 * стадии и в каком чате. Узел при этом может быть ещё «работает» — вопрос
 * посреди хода виден сразу, а не после конца хода (карточка 4).
 */
export function GroupAsk({ questions, stage, onAnswer }: GroupAskProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.island} data-group-ask={questions.length}>
      {questions.map((question) => {
        const chat = question.chatId.slice(0, 8);
        return (
          <div key={`${question.chatId}-${question.toolUseId ?? 'ask'}`} className={styles.ask}>
            <Typography variant="caption" className={styles.from} title={question.chatId}>
              {stage
                ? t('chat.cascade.hub.askFrom', {
                    stage: t(`chat.cascade.stageFull.${stage}`),
                    chat,
                  })
                : t('chat.cascade.hub.askFromNoStage', { chat })}
            </Typography>
            <ChildQuestionBody question={question} onAnswer={onAnswer} />
          </div>
        );
      })}
    </div>
  );
}
