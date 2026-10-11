import { Text, View } from 'react-native';
import type { InboxAsk } from '@agentdeck/contracts/chat-inbox';
import { styles } from './OutsideAsks.styles';

/**
 * Вопрос из терминала или VS Code — только для чтения. Варианты стоят списком,
 * а не кнопками: нажимаемый вид при ответе, который никуда не уйдёт, читался
 * как зависшее приложение (живая проверка 11.10). Где отвечать — первой строкой.
 */
export function OutsideAsks({ asks, note }: { asks: readonly InboxAsk[]; note: string }) {
  return (
    <View style={styles.box}>
      <Text style={styles.note}>{note}</Text>
      {asks.map((ask) =>
        ask.kind === 'question' ? (
          <View key={ask.key} style={styles.question}>
            {ask.question.header ? <Text style={styles.header}>{ask.question.header}</Text> : null}
            <Text style={styles.text}>{ask.question.question}</Text>
            {ask.question.options.map((option) => (
              <Text key={option.label} style={styles.option}>
                {`• ${option.label}`}
                {option.description ? (
                  <Text style={styles.description}>{` — ${option.description}`}</Text>
                ) : null}
              </Text>
            ))}
          </View>
        ) : null,
      )}
    </View>
  );
}
