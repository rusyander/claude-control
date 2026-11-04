import { useTranslation } from 'react-i18next';
import { StatusDot } from '@shared/ui/status-dot';
import { cn } from '@shared/lib/cn';
import { GroupText } from '../GroupText/GroupText';
import { GroupHead } from '../GroupText/GroupHead';
import { GroupAsk } from '../GroupAsk/GroupAsk';
import { GroupPermission } from '../GroupPermission/GroupPermission';
import type { GroupCardProps } from './GroupCard.types';
import styles from './GroupCard.module.scss';
import { hubBucket } from '../../lib/hubBucket';
import { statusTone } from '../../lib/statusTone';
import { GroupProgress } from '../GroupProgress/GroupProgress';
import { GroupAgents } from '../GroupAgents/GroupAgents';
import { RunInputs } from '../RunInputs/RunInputs';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';

/**
 * Карточка группы в хабе родителя (владелец 05.10.2026): все кнопки ЭТОЙ
 * группы — в её же карточке, справа в ряду названия; тело — под этим рядом во
 * всю ширину (22.10.2026). Кнопками-соседями под
 * строкой они читались как кнопки следующей группы. Клик по карточке открывает
 * чат группы (растянутая кнопка под текстом); кнопки ряда стоят над ней и
 * нажимаются сами по себе.
 */
export function GroupCard({
  group,
  providerId,
  onOpen,
  questions,
  onAnswer,
  permissions,
  onPermissionDecide,
}: GroupCardProps) {
  const { t } = useTranslation();
  const chatId = group.chatId;
  const asks = chatId && onAnswer && questions?.length ? questions : undefined;
  const permits = chatId && onPermissionDecide && permissions?.length ? permissions : undefined;
  const openable = Boolean(chatId && onOpen);
  const bucket = hubBucket(group);
  // Ждёт человека — своей полосой слева (владелец 22.10.2026: что требует меня,
  // должно читаться с первого взгляда по ленте карточек). Запрос прав или
  // вопрос в карточке — тоже человек (владелец 23.10): прогон на запросе прав
  // числится не «стоит», а полоса должна быть видна.
  const needsHuman = bucket === 'ask' || Boolean(permits || asks);

  return (
    <div
      className={cn(styles.group, openable && styles.groupOpenable, needsHuman && styles.groupAsk)}
      data-hub-row="chat"
      data-hub-bucket={bucket}
    >
      {/* Верхний ряд: название с фишками слева, кнопки группы справа. Тело —
          под ним во всю ширину карточки (владелец 22.10.2026): колонка кнопок
          справа во всю высоту сжимала текст до трети, и числа шли столбиком. */}
      <div className={styles.groupHead}>
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
          {/* Растянутая кнопка несёт название, а её ::after накрывает всю
              карточку — тело ниже открывает чат тем же кликом. */}
          {openable && chatId ? (
            <button
              type="button"
              className={styles.groupOpen}
              title={t('chat.cascade.hub.openHint')}
              data-hub-open
              onClick={() => onOpen?.(chatId)}
            >
              <GroupHead group={group} />
            </button>
          ) : (
            <GroupHead group={group} />
          )}
        </div>

        <div className={styles.groupActions}>
          {/* Что получил агент звена (U8) — у группы с чатом: у ждущей прогонов нет. */}
          {chatId && (
            <RunInputs inputKey={providerId ? foreignChatKey(providerId, chatId) : chatId} />
          )}
        </div>
      </div>

      <div className={styles.groupBody}>
        <GroupText
          group={group}
          {...(openable && chatId ? { step: <GroupProgress chatId={chatId} group={group} /> } : {})}
        />
      </div>

      {/* Субагенты группы: сколько идёт и закончило, переход к каждому. */}
      {openable && chatId && onOpen && (
        <GroupAgents chatId={chatId} group={group} onOpen={onOpen} />
      )}

      {/* Что под карточкой — во всю её ширину и над растянутой кнопкой:
          форма ответа, предупреждения панели. */}
      {/* Пустой список сигналов — не повод для подвала: пустой блок дал бы лишний отступ. */}
      {(permits || asks) && (
        <div className={styles.groupFoot}>
          {/* Запрос прав — первым: на нём группа стоит, на вопросе — нет. */}
          {permits && onPermissionDecide && (
            <GroupPermission
              permissions={permits}
              stage={group.stages.at(-1)}
              onDecide={onPermissionDecide}
            />
          )}
          {asks && onAnswer && (
            <GroupAsk questions={asks} stage={group.stages.at(-1)} onAnswer={onAnswer} />
          )}
        </div>
      )}
    </div>
  );
}
