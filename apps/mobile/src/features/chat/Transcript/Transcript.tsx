import { useMemo } from 'react';
import { Text, View } from 'react-native';
import type { ChatMessage } from '@agentdeck/contracts';
import { collectMessageTimings } from '@agentdeck/contracts/chat-timing';
import { useT } from '../../../shared/config/i18n';
import { AgentText } from '../AgentText/AgentText';
import { TokenBadge } from '../TokenBadge/TokenBadge';
import { summarizeToolInput } from '../toolSummary';
import { autoPickText } from '../autoPickText';
import { taskNoticesOf } from '../taskNotice';
import type { CostUnit } from '../../../shared/lib/formatSpend';
import { noticeLine } from '../noticeLine';
import { isTool } from '../isTool';
import { styles } from './Transcript.styles';

/**
 * Прошлая переписка из транскрипта. Отличается от живого потока тем, что уже
 * разложена сервером по сообщениям и блокам, — поэтому рисуется отдельно, а не
 * склеивается с потоком в общую структуру: склейка потребовала бы придумать
 * третье представление, которого нет ни у сервера, ни у потока.
 *
 * Сообщение из одних вызовов инструментов рисуется без карточки. За один ход
 * агент делает их десятки, каждый приходит отдельным сообщением, и на телефоне
 * карточка с полями превращала полтора экрана в список слова `Bash` — при том
 * что содержательного там одна строка.
 */
export function Transcript({
  messages,
  costUnit,
  isRunning = false,
}: {
  messages: ChatMessage[];
  costUnit: CostUnit;
  /** Идёт прогон — у его хвоста суммы нет: следующая запись ещё пишется. */
  isRunning?: boolean;
}) {
  const t = useT();
  // Время шагов — по соседним записям, тем же расчётом, что и в панели.
  const timings = useMemo(
    () => collectMessageTimings(messages, { openRun: isRunning }),
    [messages, isRunning],
  );
  return (
    <View style={styles.root}>
      {messages.map((message) => {
        // Итог фоновой задачи, записанный CLI от имени человека, — строкой
        // события, а не пузырём человека с простынёй XML.
        const notices = taskNoticesOf(message);
        if (notices) {
          return (
            <View key={message.id} style={styles.notice} testID="task-notice">
              {notices.map((notice, index) => (
                <Text key={index} style={styles.noticeText}>
                  {noticeLine(notice, t)}
                </Text>
              ))}
            </View>
          );
        }
        const timing = timings.get(message.id);
        const toolsOnly = message.blocks.length > 0 && message.blocks.every(isTool);
        // Расход считается моделью на всё сообщение целиком, поэтому и стоит
        // один раз под ним, а не у каждого блока: размазать одно число по
        // блокам значило бы показать несколько бейджей на один и тот же расход.
        // Подпись берём у последнего вызова инструмента — так видно, за какое
        // ДЕЙСТВИЕ заплачено, а если вызовов не было, это просто ответ.
        const tools = message.blocks.filter(isTool);
        const last = tools.at(-1);
        return (
          <View
            key={message.id}
            style={
              toolsOnly
                ? styles.toolsOnly
                : [styles.message, message.role === 'user' ? styles.user : styles.assistant]
            }
          >
            {message.blocks.map((block, index) => {
              if (block.type === 'text') {
                // Предложения панели и вложения агента приходят блоками кода
                // внутри ответа: рисунок — карточкой, остальное (решается в
                // панели) — строкой вместо сырого JSON. Текст человека служебных
                // блоков не теряет (ревью 28.09, F-226).
                return (
                  <AgentText key={index} text={block.text} fromUser={message.role === 'user'} />
                );
              }
              if (block.type === 'thinking') {
                return (
                  <Text key={index} style={styles.thinking} numberOfLines={6}>
                    {block.text}
                  </Text>
                );
              }
              if (block.type === 'tool' && block.autoPicks !== undefined) {
                // Вопрос закрыла автономия чата — след выбора, а не вызов.
                return (
                  <Text key={index} style={styles.thinking} testID="auto-pick">
                    {autoPickText(block.autoPicks, t)}
                  </Text>
                );
              }
              if (block.type === 'tool') {
                const summary = summarizeToolInput(block.input);
                return (
                  <View key={index} style={styles.toolRow}>
                    <Text style={[styles.tool, block.isError && styles.toolError]}>
                      {block.name}
                    </Text>
                    {summary ? (
                      <Text style={styles.toolSummary} numberOfLines={1}>
                        {summary}
                      </Text>
                    ) : null}
                  </View>
                );
              }
              return (
                <Text key={index} style={styles.thinking}>
                  {t.chat.image}
                </Text>
              );
            })}

            {/* Контур сжал историю перед этим ответом: без подписи ответ
                читается как ответ модели, видевшей весь разговор. */}
            {message.role !== 'user' && message.contextSummarized ? (
              <Text style={styles.summarized} testID="context-summarized">
                {t.chat.contextSummarized}
              </Text>
            ) : null}

            {message.usage ? (
              <TokenBadge
                usage={message.usage}
                unit={costUnit}
                sharedWith={tools.length}
                label={last?.type === 'tool' ? last.name : t.chat.usage.answer}
                durationMs={timing?.stepMs}
                from={timing?.from}
                to={timing?.to}
                runTotalMs={timing?.runTotalMs}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
