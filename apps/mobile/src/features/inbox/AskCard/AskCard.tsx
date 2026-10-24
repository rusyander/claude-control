import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { InboxAsk, InboxChat } from '@agentdeck/contracts/chat-inbox';
import { Button, Mono, Row } from '../../../shared/ui';
import { space } from '../../../shared/config/theme';
import { useT } from '../../../shared/config/i18n';
import { ApiError, api } from '../../../shared/api/client';
import { getRun, send } from '../../../shared/lib/runs';
import { EMPTY_CARD, cardView } from '../queue';
import { AskBody } from '../AskBody/AskBody';
import { localChatKey } from '../chatKey';
import { ageMinutes } from '../../../entities/inbox/ageMinutes';
import { sentKeys } from '../../../entities/inbox/sentKeys';
import type { AskAnswer, CardState } from '../queue.types';
import { answerAsk } from '../answerAsk';
import { editAsk } from '../editAsk';
import { reconcile } from '../reconcile';
import { planSubmissions } from '../planSubmissions';
import { submitAll } from '../submitAll';
import { markSent } from '../sent';
import { answerSummary } from '../answerSummary';
import { isRelayCard, relayDecisions } from '../relayAnswers';
import { OutsideAsks } from './OutsideAsks/OutsideAsks';
import { SourceLine } from './SourceLine/SourceLine';
import { styles } from './AskCard.styles';

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
  // Вопрос из терминала или VS Code ждёт ответа в своём окне: сообщение панели
  // туда не дойдёт, а начало бы второй ход рядом. Видно — да, ответить — нет.
  // Хук панели держит вопрос или запрос прав — решают отсюда, решение уходит
  // CLI; окно на компьютере показывает тот же запрос, принимается первое.
  const relayed = isRelayCard(asks);
  const readOnly = chat.outside === true && !relayed;

  const answer = (ask: InboxAsk, value: AskAnswer): void => {
    setFailed(undefined);
    setStored(answerAsk(state, ask.key, value));
  };

  const submitRelay = (): void => {
    const decisions = relayDecisions(asks, state);
    if (!decisions) return;
    setBusy(true);
    setFailed(undefined);
    void Promise.all(
      decisions.map((decision) =>
        api
          .post(`/outside/asks/${encodeURIComponent(decision.toolUseId)}/answer`, decision.body)
          // 409 — запрос уже решён в окне на компьютере: карточке ждать нечего.
          .catch((error: unknown) => {
            if (!(error instanceof ApiError && error.status === 409)) throw error;
          })
          .then(() => markSent(decision.keys.flatMap((key) => sentKeys(chat, { key })))),
      ),
    )
      .catch((error: unknown) => setFailed(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  const submit = (): void => {
    if (relayed) return submitRelay();
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
          <SourceLine source={chat.source} />
        </View>
        {onOpen ? (
          <Pressable accessibilityRole="link" onPress={onOpen} hitSlop={8}>
            <Text style={styles.link}>{t.home.openChat}</Text>
          </Pressable>
        ) : null}
      </Row>

      {readOnly ? <OutsideAsks asks={asks} note={t.home.outside} /> : null}

      {!readOnly &&
        view.done.map(({ ask, answer: given }) => (
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

      {!readOnly && view.current ? (
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

      {!readOnly && view.ready ? (
        <View style={styles.footer}>
          <Text style={styles.hint}>{t.home.sendHint(view.total)}</Text>
          {hasQuestions && chat.running && !relayed ? (
            <Text style={styles.hint}>{t.home.running}</Text>
          ) : null}
          <Button title={t.home.send} tone="accent" busy={busy} onPress={submit} />
        </View>
      ) : null}

      {failed !== undefined ? <Text style={styles.failed}>{t.home.sendFailed(failed)}</Text> : null}
    </View>
  );
}
