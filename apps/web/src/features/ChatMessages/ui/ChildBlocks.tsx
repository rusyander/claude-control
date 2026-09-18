import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { markQuestionAnswered, useAnsweredQuestions } from '@shared/lib/agent-runs';
import { parseQuestions } from '../lib/parseQuestions';
import { liveQuestionKey } from '../lib/questionKey';
import { QuestionCard } from './QuestionCard';
import { PermissionCard } from './PermissionCard';
import { ChildStages } from './ChildStages';
import type { ChildBlocksProps } from './ChildBlocks.types';
import styles from './ChatMessages.module.scss';

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
  onCheckOverlap,
  overlapBusy,
  permissions,
  onPermissionDecide,
  questions,
  onAnswer,
}: ChildBlocksProps) {
  const { t } = useTranslation();
  const answered = useAnsweredQuestions();

  return (
    <>
      {/*
        Сводка групп разделения — перед вопросами и правами детей: сперва «где
        все», потом «кого ждут». Ничего не спрашивает и потому стоит первой.
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
          onCheckOverlap={onCheckOverlap}
          overlapBusy={overlapBusy}
        />
      )}

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
        (questions ?? []).map((child) => {
          const parsed = parseQuestions(child.input);
          if (!parsed) return null;
          const key = liveQuestionKey(child.chatId, child.toolUseId, child.input);
          return (
            <div key={`${child.chatId}-${child.toolUseId ?? 'ask'}`} className={styles.childAsk}>
              <Typography variant="caption" color="subtle" className={styles.childAskFrom}>
                {t('chat.questionFromChild', { title: child.title })}
              </Typography>
              <QuestionCard
                questions={parsed}
                onPick={(answer) => {
                  markQuestionAnswered(key);
                  onAnswer(child.chatId, answer);
                }}
                busy={child.isRunning}
                isAnswered={answered.has(key)}
                // Подпись сохраняется и ПОСЛЕ ответа: «отправлено» без имени
                // разговора не говорит, кому именно из шестерых человек ответил.
                target={child.title}
              />
            </div>
          );
        })}
    </>
  );
}
