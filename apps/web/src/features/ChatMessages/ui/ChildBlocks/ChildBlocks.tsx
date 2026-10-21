import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { cardQuestions } from '../../lib/cardQuestions';
import { ChildQuestionBody } from '../ChildQuestionBody/ChildQuestionBody';
import { PermissionCard } from '../PermissionCard/PermissionCard';
import { ChildStages } from '../ChildStages/ChildStages';
import type { ChildBlocksProps } from './ChildBlocks.types';
import styles from './ChildBlocks.module.scss';

/**
 * Всё о ДЕТЯХ разговора в одном месте ленты: где группы стоят, кого из них
 * держат права и кто задал вопрос.
 *
 * Разделение задач разводит работу по нескольким агентам, но человек остаётся
 * один — обходить их вкладки по кругу ради одного и того же выбора не работа.
 * Поэтому и сводка, и запросы прав, и вопросы детей живут в родительском
 * разговоре, с подписью, чей это.
 *
 * Отдельным файлом — потому что вместе это цельный кусок ленты и он же был
 * самым крупным из тех, чем `ChatMessages` перерос предел длины.
 */
export function ChildBlocks({
  stages,
  onOpenChild,
  tree,
  onPauseTree,
  onResumeTree,
  treeBusy,
  onAnswerHold,
  holdBusy,
  onRelease,
  releaseBusy,
  onResumeInterrupted,
  resumeInterruptedBusy,
  onCheckOverlap,
  overlapBusy,
  permissions,
  onPermissionDecide,
  questions,
  onAnswer,
}: ChildBlocksProps) {
  const { t } = useTranslation();
  // Вопрос группы с карточкой в хабе — в самой карточке (карточка 27); полоса
  // держит запросы прав и вопросы чатов, у которых своей карточки нет.
  const { inCards, strip } = cardQuestions(onOpenChild ? (stages ?? []) : [], questions ?? []);
  const hasAsks =
    (Boolean(onPermissionDecide) && (permissions ?? []).length > 0) ||
    (Boolean(onAnswer) && strip.length > 0);

  return (
    <>
      {/*
        Полоса запросов детей — НАД строками хаба (аудит 25.09, L153): карточка
        права или вопроса группы — это агент, который стоит, и под длинным
        хабом из десятка групп её не находили. Сперва «кого ждут», потом «где все».
      */}
      {hasAsks && (
        <div className={styles.childAsks} data-child-asks>
          {/*
          Запросы прав дочерних разговоров. Показываются рядом со своими и по
          более веской причине: на запросе прав агент СТОИТ. Подпись обязательна —
          разрешать «удалить каталог» вслепую, не зная, кто из шести просит,
          человек не должен.
        */}
          {onPermissionDecide &&
            (permissions ?? []).map((child) => (
              <div key={child.chatId} className={styles.childAsk}>
                <Typography variant="caption" color="subtle" className={styles.childAskFrom}>
                  {t('chat.permissionFromChild', { title: child.title })}
                </Typography>
                <PermissionCard
                  permissions={child.permissions}
                  onDecide={(toolUseId, behavior) =>
                    onPermissionDecide(child.chatId, toolUseId, behavior)
                  }
                />
              </div>
            ))}

          {/*
          Вопросы дочерних разговоров. Ответ уходит в ИХ чат — этот разговор о нём
          не узнает и хода себе не добавит. Подпись обязательна: одинаковых
          вопросов от шести агентов бывает шесть, и без имени чата человек отвечает
          вслепую.
        */}
          {onAnswer &&
            strip.map((child) => (
              <div
                key={`${child.chatId}-${child.text ? 'text' : (child.toolUseId ?? 'ask')}`}
                className={styles.childAsk}
              >
                <Typography variant="caption" color="subtle" className={styles.childAskFrom}>
                  {t('chat.questionFromChild', { title: child.title })}
                </Typography>
                <ChildQuestionBody question={child} onAnswer={onAnswer} />
              </div>
            ))}
        </div>
      )}

      {/*
        Сводка групп разделения — ПОД полосой запросов: она ничего не
        спрашивает, а полоса держит стоящих агентов.
      */}
      {onOpenChild && (
        <ChildStages
          groups={stages ?? []}
          onOpen={onOpenChild}
          tree={tree}
          onPauseAll={onPauseTree}
          onResumeAll={onResumeTree}
          treeBusy={treeBusy}
          onAnswerHold={onAnswerHold}
          holdBusy={holdBusy}
          onRelease={onRelease}
          releaseBusy={releaseBusy}
          onResumeInterrupted={onResumeInterrupted}
          resumeInterruptedBusy={resumeInterruptedBusy}
          onCheckOverlap={onCheckOverlap}
          overlapBusy={overlapBusy}
          {...(onAnswer && inCards.size > 0 ? { questions: inCards, onAnswer } : {})}
        />
      )}
    </>
  );
}
