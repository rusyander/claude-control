import { useState } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Button, Card, Field, Loading, Muted, Row, Screen, Title } from '../src/shared/ui';
import { colors, font, radius, space } from '../src/shared/config/theme';
import { useT } from '../src/shared/config/i18n';
import {
  commandsForChoice,
  openAskCards,
  sendCoreCommands,
  useAskDetails,
  useCoreTask,
  useCoreTasks,
  type CoreAskCard,
  type CoreAskChoice,
} from '../src/entities/core-task';

/**
 * Задача ядра на телефоне: открытые вопросы карточками. Вариант — кнопкой, свой ответ — полем;
 * ответ уходит командой, подписанной ключом телефона (ядро с телефона иначе не примет). Вопрос из
 * push (`ask`) — первым.
 */
export default function CoreTaskScreen() {
  const t = useT();
  const params = useLocalSearchParams<{ id?: string; ask?: string }>();
  const taskId = typeof params.id === 'string' ? params.id : undefined;
  const task = useCoreTask(taskId);
  const details = useAskDetails(taskId);
  const view = task.data?.view;
  // Заголовок — в списке задач, в виде задачи его нет.
  const title = useCoreTasks().data?.tasks.find((one) => one.taskId === taskId)?.title;
  const cards = openAskCards(view?.asks ?? [], details).sort(
    (a, b) => Number(b.askId === params.ask) - Number(a.askId === params.ask),
  );

  return (
    <>
      <Stack.Screen options={{ title: t.coreTask.taskTitle }} />
      <Screen
        scroll
        refreshControl={
          <RefreshControl
            refreshing={task.isFetching}
            onRefresh={() => void task.refetch()}
            tintColor={colors.accent}
          />
        }
      >
        {task.isLoading ? <Loading /> : null}
        {task.error ? (
          <Card>
            <Text style={styles.bad}>{(task.error as Error).message}</Text>
          </Card>
        ) : null}
        {view ? (
          <Card>
            <Title>{title?.trim() || t.coreTask.untitled}</Title>
            <Muted>
              {[task.data?.live ? t.coreTask.live : t.coreTask.ended, view.state].join(' · ')}
            </Muted>
          </Card>
        ) : null}
        {view && cards.length === 0 ? (
          <Card>
            <Muted>{t.coreTask.noAsks}</Muted>
          </Card>
        ) : null}
        <View style={styles.list}>
          {taskId
            ? cards.map((card) => (
                <AskCard
                  key={card.askId}
                  taskId={taskId}
                  card={card}
                  onDone={() => void task.refetch()}
                />
              ))
            : null}
        </View>
      </Screen>
    </>
  );
}

function AskCard({
  taskId,
  card,
  onDone,
}: {
  taskId: string;
  card: CoreAskCard;
  onDone: () => void;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);

  const choose = async (choice: CoreAskChoice): Promise<void> => {
    const drafts = commandsForChoice(taskId, card, choice);
    if (!drafts) {
      setOutcome({ ok: false, text: t.coreTask.editInPanel });
      return;
    }
    setBusy(true);
    const result = await sendCoreCommands(drafts);
    setBusy(false);
    if (result.ok) {
      setOutcome({ ok: true, text: t.coreTask.applied });
      onDone();
    } else if (result.code === 'no-key') {
      setOutcome({ ok: false, text: t.coreTask.noKey });
    } else {
      setOutcome({ ok: false, text: t.coreTask.refused(result.code) });
    }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.question}>{card.question || t.coreTask.questionPending}</Text>
      <Row gap={space.sm} style={styles.options}>
        {card.options.map((option) => (
          <Button
            key={option}
            title={option}
            tone={option === card.defaultAction ? 'accent' : 'default'}
            disabled={busy}
            onPress={() =>
              void choose({ type: 'option', option, cancelReason: t.coreTask.cancelReason })
            }
          />
        ))}
      </Row>
      <Field
        value={text}
        onChangeText={setText}
        placeholder={t.coreTask.ownAnswer}
        multiline
        autoCapitalize="sentences"
      />
      <Button
        title={t.coreTask.send}
        tone="accent"
        busy={busy}
        disabled={!text.trim()}
        onPress={() => void choose({ type: 'text', text })}
      />
      {outcome ? <Text style={outcome.ok ? styles.good : styles.bad}>{outcome.text}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.sm },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  question: { color: colors.text, fontSize: font.body },
  options: { flexWrap: 'wrap' },
  good: { color: colors.success, fontSize: font.small },
  bad: { color: colors.danger, fontSize: font.small },
});
