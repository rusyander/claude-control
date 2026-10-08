import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { StatusDot } from '@shared/ui/status-dot';
import { cn } from '@shared/lib/cn';
import { serverFieldText } from '@shared/config/i18n';
import { GroupCopyCleanup } from '../GroupCopyCleanup/GroupCopyCleanup';
import { GroupControl } from '../GroupControl/GroupControl';
import { GroupAcceptance } from '../GroupAcceptance/GroupAcceptance';
import { GroupRecheck } from '../GroupRecheck/GroupRecheck';
import { SplitTasksMove } from '../SplitTasksMove/SplitTasksMove';
import { GroupAutoNotices } from '../GroupAutoNotices/GroupAutoNotices';
import { GroupText } from '../GroupText/GroupText';
import { MergeOrderChip } from '../MergeOrderChip/MergeOrderChip';
import type { GroupCardProps } from './GroupCard.types';
import styles from './GroupCard.module.scss';
import { isMrSettled } from '../../lib/isMrSettled';
import { statusTone } from '../../lib/statusTone';
import { HoldAnswer } from './HoldAnswer/HoldAnswer';
import { GroupStepLine } from '../GroupStepLine/GroupStepLine';

/**
 * Карточка группы в хабе родителя (владелец 05.10.2026): текст слева, все
 * кнопки ЭТОЙ группы — в её же карточке, справа сверху. Кнопками-соседями под
 * строкой они читались как кнопки следующей группы. Клик по карточке открывает
 * чат группы (растянутая кнопка под текстом), а MR — только своей кнопкой:
 * ссылка внутри кликабельной строки уводила то в MR, то в чат.
 */
export function GroupCard({
  group,
  parentChatId,
  onOpen,
  onAnswerHold,
  holdBusy,
  onRelease,
  releaseBusy,
  onResumeInterrupted,
  resumeInterruptedBusy,
}: GroupCardProps) {
  const { t } = useTranslation();
  const chatId = group.chatId;
  const openable = Boolean(chatId && onOpen);
  const mrId = group.mr?.match(/(\d+)$/)?.[1] ?? '';
  const cleanup = group.copy && parentChatId ? group.copy : undefined;
  const release =
    !chatId && group.pending === 'waiting' && group.groupIndex !== undefined && onRelease;
  const settled = isMrSettled(group) ? group.mrClosed : undefined;

  return (
    <div
      className={cn(
        styles.group,
        openable && styles.groupOpenable,
        settled === 'merged' && styles.groupMerged,
        settled === 'closed' && styles.groupClosed,
      )}
      data-hub-row={chatId ? 'chat' : group.pending}
      {...(settled ? { 'data-hub-settled': settled } : {})}
    >
      <div className={styles.groupBody}>
        <div className={styles.groupMain}>
          {/* Идущий прогон пульсирует, законченное звено стоит ровно; у группы
              без чата точка ровная всегда: она ждёт, чего — сказано текстом. */}
          <span className={styles.groupDot}>
            <StatusDot
              tone={statusTone(group)}
              pulse={Boolean(chatId) && group.isRunning}
              label={t(
                chatId && group.isRunning ? 'chat.cascade.hub.running' : 'chat.cascade.hub.idle',
              )}
            />
          </span>
          {openable && chatId ? (
            <button
              type="button"
              className={styles.groupOpen}
              title={t('chat.cascade.hub.openHint')}
              data-hub-open
              onClick={() => onOpen?.(chatId)}
            >
              <GroupText
                group={group}
                step={<GroupStepLine chatId={chatId} isRunning={group.isRunning} />}
              />
            </button>
          ) : (
            <GroupText group={group} />
          )}
        </div>

        <div className={styles.groupActions}>
          {cleanup && !cleanup.cleaned && parentChatId && (
            <GroupCopyCleanup parentChatId={parentChatId} index={cleanup.index} />
          )}
          {/* Номер в очереди слияния — вплотную к кнопке MR и переносится с ней
              одним куском (G3): оторванный, он читался бы про соседнюю кнопку. */}
          {group.mr && (
            <span className={styles.mrPair}>
              {group.mergeOrder && <MergeOrderChip order={group.mergeOrder} />}
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Icon name="link" size={14} />}
                title={t('chat.cascade.hub.mrOpenHint')}
                data-hub-mr
                onClick={() => window.open(group.mr, '_blank', 'noopener,noreferrer')}
              >
                {t('chat.cascade.hub.mr', { id: mrId })}
              </Button>
            </span>
          )}
          {group.recheck && <GroupRecheck recheck={group.recheck} />}
          {group.taskMove && parentChatId && (
            <SplitTasksMove
              parentChatId={parentChatId}
              index={group.taskMove.index}
              keys={group.taskMove.keys}
              connected={group.taskMove.connected}
            />
          )}
          {group.acceptance && <GroupAcceptance acceptance={group.acceptance} />}
          {group.interrupted && onResumeInterrupted && (
            <div className={styles.holdActions} data-resume-interrupted="group">
              <Button
                size="sm"
                variant="secondary"
                isLoading={resumeInterruptedBusy}
                title={t('chat.cascade.hub.resumeInterruptedHint')}
                onClick={() => onResumeInterrupted(group.interrupted?.index)}
              >
                {t('chat.cascade.hub.resumeInterrupted')}
              </Button>
            </div>
          )}
          {/* Группа ждёт предшественников — единственная кнопка, которой её
              можно сдвинуть: цепочка предшественника могла не кончиться вовсе
              (прогон остановили, чат удалили, панель перезапустили). Подпись
              говорит, чем человек платит: копия всё равно отводится от ветки
              предшественника, а в задании сказано, что та работа не закончена. */}
          {release && (
            <div className={styles.holdActions} data-release-group>
              <Button
                size="sm"
                variant="secondary"
                isLoading={releaseBusy}
                title={t('chat.cascade.hub.releaseHint')}
                onClick={() => onRelease(group.groupIndex ?? 0)}
              >
                {t('chat.cascade.hub.release')}
              </Button>
            </div>
          )}
          {group.control && <GroupControl control={group.control} />}
        </div>
      </div>

      {/* Что под карточкой — во всю её ширину и над растянутой кнопкой:
          форма ответа, отметка уборки копии, предупреждения панели. */}
      {(cleanup?.cleaned || group.hold || group.autoNotices) && (
        <div className={styles.groupFoot}>
          {cleanup?.cleaned && parentChatId && (
            <GroupCopyCleanup
              parentChatId={parentChatId}
              index={cleanup.index}
              cleaned={cleanup.cleaned}
            />
          )}
          {!chatId && group.pending === 'held' && group.hold && onAnswerHold && (
            <HoldAnswer
              question={serverFieldText(group.hold, 'question')}
              busy={holdBusy}
              onSend={(answer) => onAnswerHold(group.hold?.index ?? 0, answer)}
            />
          )}
          {group.autoNotices && <GroupAutoNotices autoNotices={group.autoNotices} />}
        </div>
      )}
    </div>
  );
}
