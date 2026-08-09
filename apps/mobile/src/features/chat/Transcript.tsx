import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ChatBlock, ChatMessage } from '@claude-control/contracts';
import { colors, font, radius, space } from '../../shared/config/theme';
import { useT } from '../../shared/config/i18n';
import type { CostUnit } from '../../shared/lib/format';
import { Markdown } from './Markdown';
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
}: {
  messages: ChatMessage[];
  costUnit: CostUnit;
}) {
  const t = useT();
  return (
    <View style={styles.root}>
      {messages.map((message) => {
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
              if (block.type === 'text') return <Markdown key={index}>{block.text}</Markdown>;
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

            {message.usage ? (
              <TokenBadge
                usage={message.usage}
                unit={costUnit}
                sharedWith={tools.length}
                label={last?.type === 'tool' ? last.name : t.chat.usage.answer}
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
  toolSummary: { color: colors.textFaint, fontSize: font.small, fontFamily: font.mono, flex: 1 },
});
