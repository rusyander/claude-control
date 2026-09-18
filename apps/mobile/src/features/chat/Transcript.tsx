import { useMemo, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ChatBlock, ChatMessage } from '@agentdeck/contracts';
import { collectMessageTimings } from '@agentdeck/contracts/chat-timing';
import { colors, font, radius, space } from '../../shared/config/theme';
import { useT } from '../../shared/config/i18n';
import type { CostUnit } from '../../shared/lib/format';
import { AgentText } from './AgentText';
import { TokenBadge } from './TokenBadge';
import { summarizeToolInput } from './toolSummary';

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
                // панели) — строкой вместо сырого JSON.
                return <AgentText key={index} text={block.text} />;
              }
              if (block.type === 'thinking') {
                return (
                  <Text key={index} style={styles.thinking} numberOfLines={6}>
                    {block.text}
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

function isTool(block: ChatBlock): boolean {
  return block.type === 'tool';
}

/**
 * Пузырь своего сообщения отдельно от ленты: пока прогон идёт, транскрипт ещё
 * не дописан, и отправленная задача иначе исчезает с экрана до самого конца
 * работы — человек не видит, что именно он послал.
 */
export function UserBubble({ children }: { children: ReactNode }) {
  return <View style={[styles.message, styles.user]}>{children}</View>;
}

const styles = StyleSheet.create({
  root: { gap: space.md },
  message: {
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
    borderWidth: 1,
  },
  user: {
    backgroundColor: colors.accentDim,
    borderColor: colors.accentDim,
    alignSelf: 'flex-end',
    maxWidth: '92%',
  },
  assistant: { backgroundColor: colors.surface, borderColor: colors.border },
  toolsOnly: { gap: space.xs, marginVertical: -space.xs },
  thinking: { color: colors.textFaint, fontSize: font.small, fontStyle: 'italic', lineHeight: 18 },
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  tool: { color: colors.accent, fontSize: font.small, fontFamily: font.mono },
  toolError: { color: colors.danger },
  summarized: { color: colors.warning, fontSize: font.small, lineHeight: 18 },
  toolSummary: { color: colors.textFaint, fontSize: font.small, fontFamily: font.mono, flex: 1 },
});
