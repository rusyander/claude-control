import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { InboxAsk, InboxChat } from '@agentdeck/contracts/chat-inbox';
import { Button, Mono, Row } from '../../shared/ui';
import { colors, font, space } from '../../shared/config/theme';
import { useT, type Dictionary } from '../../shared/config/i18n';
import { api } from '../../shared/api/client';
import { getRun, send } from '../../shared/lib/runs';
import { ageMinutes, sentKeys } from '../../entities/inbox/model';
import {
  EMPTY_CARD,
  answerAsk,
  cardView,
  editAsk,
  planSubmissions,
  reconcile,
  submitAll,
  type AskAnswer,
  type CardState,
} from './queue';
import { AskBody } from './AskBody';
import { localChatKey } from './chatKey';
import { markSent } from './sent';

/**
 * Карточка одного чата во вкладке «Вопросы»: вопросы по одному, отвеченные
 * сворачиваются в строку, после последнего — «Отправить» на всё сразу.
 * Отправленное помечается и карточка уходит, не дожидаясь следующего опроса.
 */
export function AskCard({
  chat,
  asks,
  now,
  onOpen,
}: {
  chat: InboxChat;
  asks: readonly InboxAsk[];
  now: number;
  /** Нет — карточка стоит в самом чате, и ссылка «Открыть чат» вела бы в него же. */
  onOpen?: () => void;
}) {
  const t = useT();
  const [stored, setStored] = useState<CardState>(EMPTY_CARD);
  // Сервер отдаёт вопросы каждым опросом заново: выбранное сводится с тем, что
  // пришло сейчас, прямо при отрисовке — иначе экран на кадр показал бы ответ
  // на вопрос, которого уже нет.
  const state = reconcile(stored, asks);
  useEffect(() => {
    if (state !== stored) setStored(state);
  }, [state, stored]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | undefined>();

  const view = cardView(asks, state);
  const hasQuestions = asks.some((ask) => ask.kind === 'question');

  const answer = (ask: InboxAsk, value: AskAnswer): void => {
    setFailed(undefined);
    setStored(answerAsk(state, ask.key, value));
  };

  const submit = (): void => {
    const plan = planSubmissions(chat, asks, state);
    setBusy(true);
    setFailed(undefined);
    void submitAll(plan, {
      post: (path, body) => api.post(path, body),
      sendMessage: (text) => {
        const key = localChatKey(chat);
        const run = getRun(key);
        return send({
          chatId: key,
          prompt: text,
          sessionId: run.sessionId ?? chat.sessionId,
          projectPath: chat.projectPath,
          // Как у поля ввода чата: правки разрешены, пока человек не решил иначе.
          allowEdits: run.allowEdits ?? true,
          autoApprove: run.autoApprove,
        });
      },
    })
      .then((outcome) => {
        markSent(outcome.sentKeys.flatMap((key) => sentKeys(chat, { key })));
        if (outcome.error !== undefined) setFailed(outcome.error);
      })
      .finally(() => setBusy(false));
  };

  return (
    <View style={styles.card}>
      <Row gap={space.sm}>
        <View style={styles.grow}>
          <Text style={styles.title} numberOfLines={2}>
            {chat.title}
          </Text>
          <Mono numberOfLines={1}>
            {chat.isSandbox ? t.home.sandbox : chat.project}
            {' · '}
            {t.home.age(ageMinutes(asks[0]?.askedAt ?? chat.updatedAt, now))}
          </Mono>
        </View>
        {onOpen ? (
          <Pressable accessibilityRole="link" onPress={onOpen} hitSlop={8}>
            <Text style={styles.link}>{t.home.openChat}</Text>
          </Pressable>
        ) : null}
      </Row>

      {view.done.map(({ ask, answer: given }) => (
        <View key={ask.key} style={styles.done}>
          <Text style={styles.doneMark}>✓</Text>
          <Text style={styles.doneText} numberOfLines={1}>
            {answerSummary(t, ask, given)}
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => setStored(editAsk(state, ask.key))}
            hitSlop={8}
          >
            <Text style={styles.link}>{t.home.change}</Text>
          </Pressable>
        </View>
      ))}

      {view.current ? (
        <View style={styles.current}>
          {view.total > 1 ? (
            <Mono style={styles.step}>{t.home.step(view.step, view.total)}</Mono>
          ) : null}
          <AskBody
            ask={view.current}
            previous={state.answers[view.current.key]}
            disabled={busy}
            onAnswer={(value) => view.current && answer(view.current, value)}
          />
          {view.upcoming.length > 0 ? (
            <Text style={styles.hint}>{t.home.more(view.upcoming.length)}</Text>
          ) : null}
        </View>
      ) : null}

      {view.ready ? (
        <View style={styles.footer}>
          <Text style={styles.hint}>{t.home.sendHint(view.total)}</Text>
          {hasQuestions && chat.running ? <Text style={styles.hint}>{t.home.running}</Text> : null}
          <Button title={t.home.send} tone="accent" busy={busy} onPress={submit} />
        </View>
      ) : null}

      {failed !== undefined ? <Text style={styles.failed}>{t.home.sendFailed(failed)}</Text> : null}
    </View>
  );
}

/** Свёрнутый ответ одной строкой: что спросили и что выбрано. */
function answerSummary(t: Dictionary, ask: InboxAsk, answer: AskAnswer): string {
  if (answer.kind === 'permission') {
    return `${t.home.answered[answer.behavior]} · ${'toolName' in ask ? ask.toolName : ''}`;
  }
  if (answer.kind === 'branchGate') return t.home.answered[answer.choice];
  const title = ask.kind === 'question' ? ask.question.header || ask.question.question : '';
  return title ? `${title}: ${answer.labels.join(', ')}` : answer.labels.join(', ');
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: 10,
    padding: space.md,
    gap: space.sm,
  },
  grow: { flex: 1 },
  title: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  link: { color: colors.accent, fontSize: font.small },
  done: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  doneMark: { color: colors.success, fontSize: font.body, fontWeight: '700' },
  doneText: { color: colors.textDim, fontSize: font.small, flex: 1 },
  current: { gap: space.sm },
  step: { color: colors.textFaint },
  hint: { color: colors.textDim, fontSize: font.small, lineHeight: 17 },
  footer: { gap: space.sm },
  failed: { color: colors.danger, fontSize: font.small },
});
