import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
// Своя KeyboardAvoidingView, а не та, что в react-native. Начиная с
// edge-to-edge (Expo SDK 54+) окно под клавиатуру больше не сжимается: системная
// `adjustResize` меняет только отступы, и родная реализация на Android просто
// ничего не делала — поле ввода оставалось ЗА клавиатурой. Эта следит за
// клавиатурой напрямую и работает одинаково на обеих системах.
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import type { ChatMessage } from '@claude-control/contracts';
import { Empty, Loading, Mono, Row, StatusDot } from '../../src/shared/ui';
import { colors, font, space } from '../../src/shared/config/theme';
import { useT } from '../../src/shared/config/i18n';
import { isConfigured, useConnection } from '../../src/shared/api/connection';
import { newChatId, openChat, useWorkspace } from '../../src/shared/lib/workspace';
import {
  cancelQueued,
  quietRun,
  send,
  stop,
  useRun,
  visibleStatus,
} from '../../src/shared/lib/runs';
import { chatMessagesQuery, useChatMessages, useChatProgress } from '../../src/entities/chat/api';
import { useCostUnit } from '../../src/entities/settings/api';
import { formatSpend } from '../../src/shared/lib/format';
import { Composer, type ComposerValue } from '../../src/features/chat/Composer';
import { Markdown } from '../../src/features/chat/Markdown';
import { PermissionCard } from '../../src/features/chat/PermissionCard';
import { Progress } from '../../src/features/chat/Progress';
import { TokenBadge } from '../../src/features/chat/TokenBadge';
import { ToolCall } from '../../src/features/chat/ToolCall';
import { Transcript, UserBubble } from '../../src/features/chat/Transcript';

/**
 * Разговор — то, ради чего приложение существует: видеть, что делает агент,
 * отвечать на его вопросы и ставить новую задачу с телефона, пока он работает
 * на машине дома.
 *
 * Лента склеена из двух источников, и это не небрежность. Прошлое приходит из
 * транскрипта (сервер уже разложил его по сообщениям), настоящее — из живого
 * потока, где транскрипт ещё не дописан. Сводить их в одну структуру пришлось бы
 * через третье представление, которого нет ни у сервера, ни у потока.
 */
export default function ChatScreen() {
  const t = useT();
  const router = useRouter();
  const connection = useConnection();
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const scrollRef = useRef<ScrollView>(null);

  // Разговор без id — ещё не начатый: заводим временный, настоящий придёт от
  // сервера первым же событием потока.
  useEffect(() => {
    if (workspace.ready && !workspace.chatId) openChat(newChatId());
  }, [workspace.ready, workspace.chatId]);

  const chatId = workspace.chatId;
  const run = useRun(chatId);
  const status = visibleStatus(run);
  const isRunning = run.status === 'running';

  const messages = useChatMessages(chatId);
  const progress = useChatProgress(run.sessionId ?? chatId, isRunning);
  // Единицы расхода выбираются один раз в самой панели — телефон им следует.
  const costUnit = useCostUnit();

  const [value, setValue] = useState<ComposerValue>({
    text: '',
    allowEdits: true,
    autoApprove: false,
    model: '',
    effort: '',
    files: [],
  });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');

  // Ход закончился — транскрипт дописан, и его пора перечитать: иначе ответ
  // останется только в живом потоке и пропадёт при перезапуске приложения.
  //
  // Тогда же начатый здесь разговор становится настоящим: временный `new-*` id
  // меняется на сессию, которую выдал Claude Code. Пока этого не сделано, чат
  // существует только в памяти приложения — транскрипт по временному id не
  // читается, а следующее сообщение уходило бы БЕЗ `--resume`, начиная новый
  // разговор вместо продолжения. Подменяем id, лишь когда лента новой сессии
  // действительно прочиталась: иначе экран на миг остаётся пустым — живой
  // прогон уже не наш, а истории ещё нет.
  const wasRunning = useRef(isRunning);
  const finishedAt = useRef(0);
  useEffect(() => {
    if (wasRunning.current && !isRunning) {
      finishedAt.current = Date.now();
      void queryClient.invalidateQueries({ queryKey: ['chat'] });
      void queryClient.invalidateQueries({ queryKey: ['chats'] });
      void queryClient.invalidateQueries({ queryKey: ['project-files'] });
      void queryClient.invalidateQueries({ queryKey: ['project-git'] });

      const sessionId = run.sessionId;
      if (sessionId && sessionId !== chatId && isDraft(chatId)) {
        void queryClient
          .fetchQuery(chatMessagesQuery(sessionId))
          .then(() => openChat(sessionId))
          .catch(() => undefined);
      }
    }
    wasRunning.current = isRunning;
  }, [isRunning, queryClient, chatId, run.sessionId]);

  // Лента перечиталась уже после конца хода и ответ в ней есть — значит поток
  // договорил своё и обязан замолчать: иначе один и тот же ответ стоит на
  // экране дважды, из транскрипта и из потока.
  const messagesUpdatedAt = messages.dataUpdatedAt;
  useEffect(() => {
    if (isRunning || !run.text) return;
    if (!finishedAt.current || messagesUpdatedAt <= finishedAt.current) return;
    if (!messages.data?.messages.some((message) => message.role === 'assistant')) return;
    quietRun(chatId);
  }, [messagesUpdatedAt, messages.data, isRunning, run.text, chatId]);

  const onSend = useCallback(() => {
    const prompt = value.text.trim();
    if (!prompt) return;
    setBusy(true);
    setFailed('');
    void send({
      chatId,
      prompt,
      // Разговор продолжается только с `--resume`, а сессия для него — либо та,
      // что пришла потоком, либо сам id открытого чата: у чата из списка он и
      // есть id сессии. Без второго слагаемого сообщение в старый разговор
      // начинало новый, и ответ уходил мимо той переписки, что человек видел.
      sessionId: run.sessionId ?? (isDraft(chatId) ? undefined : chatId),
      projectPath: workspace.projectPath || undefined,
      allowEdits: value.allowEdits,
      autoApprove: value.autoApprove,
      model: value.model || undefined,
      effort: value.effort || undefined,
      files: value.files.length > 0 ? value.files : undefined,
    })
      .then((outcome) => {
        // Поле очищается, только когда сервер ПРИНЯЛ сообщение: иначе отказ
        // уничтожает набранный текст и печатать приходится заново.
        if (outcome.ok) setValue((state) => ({ ...state, text: '', files: [] }));
        else setFailed(outcome.message);
      })
      .finally(() => setBusy(false));
  }, [chatId, run.sessionId, value, workspace.projectPath]);

  const projectName = useMemo(() => {
    if (!workspace.projectPath) return t.chat.homeChat;
    return workspace.projectPath.split(/[\\/]/).filter(Boolean).pop() ?? workspace.projectPath;
  }, [workspace.projectPath, t]);

  if (!isConfigured(connection)) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <Empty text={t.common.notConnectedChat} />
      </SafeAreaView>
    );
  }

  const history = messages.data?.messages ?? [];
  const isBlank = history.length === 0 && !run.text && !run.thinking && !isRunning;
  // Транскрипт перечитывается только по окончании хода, поэтому своя задача
  // показывается из состояния прогона — и убирается, как только доехала лента.
  const sent =
    run.lastPrompt && run.status !== 'idle' && !inHistory(history, run.lastPrompt)
      ? run.lastPrompt
      : '';

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Row gap={space.sm} style={styles.headerMain}>
          <StatusDot status={status} />
          <Text style={styles.project} numberOfLines={1}>
            {projectName}
          </Text>
        </Row>
        <Row gap={space.xs}>
          {/* Итог хода — рядом с названием проекта, как в шапке чата панели:
              сумма шагов сама по себе нигде больше не видна. */}
          {run.tokens > 0 ? (
            <Text style={styles.spend}>{formatSpend(costUnit, run.tokens, run.costUsd ?? 0)}</Text>
          ) : null}
          <Pressable onPress={() => router.push('/chats')} style={styles.headerButton}>
            <Text style={styles.headerButtonText}>{t.chat.conversations}</Text>
          </Pressable>
          {workspace.projectPath ? (
            <Pressable onPress={() => router.push('/code')} style={styles.headerButton}>
              <Text style={styles.headerButtonText}>{t.chat.code}</Text>
            </Pressable>
          ) : null}
          {/* Тесты рядом с кодом: оба отвечают на вопрос «в каком состоянии
              проект», просто с разных сторон. */}
          {workspace.projectPath ? (
            <Pressable onPress={() => router.push('/tests')} style={styles.headerButton}>
              <Text style={styles.headerButtonText}>{t.chat.tests}</Text>
            </Pressable>
          ) : null}
        </Row>
      </View>

      {/* Вкладки при открытой клавиатуре прячутся (`tabBarHideOnKeyboard`),
          поэтому смещение под них не нужно: лишний отступ оставил бы под полем
          пустую полосу. */}
      <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={0}>
        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.feed}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
          keyboardShouldPersistTaps="handled"
        >
          {messages.isLoading ? <Loading /> : null}
          <Transcript messages={history} costUnit={costUnit} />

          {sent ? (
            <UserBubble>
              <Markdown>{sent}</Markdown>
            </UserBubble>
          ) : null}

          {run.thinking ? (
            <Text style={styles.thinking} numberOfLines={8}>
              {run.thinking}
            </Text>
          ) : null}

          {run.tools.map((tool, index) => (
            <ToolCall key={tool.id ?? `tool-${index}`} tool={tool} costUnit={costUnit} />
          ))}

          {run.text ? <Markdown>{run.text}</Markdown> : null}
          {/* Расход ответа виден сразу, а не только после того, как ход
              закончится и лента перечитается из транскрипта. */}
          {run.text && run.textUsage ? (
            <TokenBadge usage={run.textUsage} unit={costUnit} label={t.chat.usage.answer} />
          ) : null}

          {run.permissions.map((permission) => (
            <PermissionCard key={permission.toolUseId} chatId={chatId} permission={permission} />
          ))}

          {run.error ? <Text style={styles.error}>{run.error}</Text> : null}
          {failed ? <Text style={styles.error}>{failed}</Text> : null}

          {isBlank ? <Empty text={t.chat.blank} /> : null}
        </ScrollView>

        {run.queued.length > 0 ? (
          <View style={styles.queue}>
            {run.queued.map((item) => (
              <Pressable key={item.id} onPress={() => cancelQueued(chatId, item.id)}>
                <Mono numberOfLines={1}>{t.chat.queued(item.prompt)}</Mono>
              </Pressable>
            ))}
          </View>
        ) : null}

        <Progress progress={progress.data} />

        <Composer
          value={value}
          onChange={setValue}
          onSend={onSend}
          onStop={() => void stop(chatId)}
          isRunning={isRunning}
          busy={busy}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** Ещё не начатый разговор: id временный, сессии за ним не стоит. */
function isDraft(chatId: string): boolean {
  return chatId.startsWith('new-');
}

/**
 * Доехал ли отправленный текст до транскрипта. Смотрим хвост, а не всю ленту:
 * сервер дописывает сообщение в конец, и сравнивать сотни старых незачем.
 */
function inHistory(messages: ChatMessage[], prompt: string): boolean {
  return messages
    .slice(-8)
    .some(
      (message) =>
        message.role === 'user' &&
        message.blocks.some((block) => block.type === 'text' && block.text.trim() === prompt),
    );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
    gap: space.sm,
  },
  headerMain: { flex: 1 },
  project: { color: colors.text, fontSize: font.title, fontWeight: '600', flex: 1 },
  spend: { color: colors.textFaint, fontSize: font.small, fontFamily: font.mono },
  headerButton: { paddingHorizontal: space.sm, paddingVertical: space.xs },
  headerButtonText: { color: colors.accent, fontSize: font.small },
  feed: { padding: space.md, gap: space.sm },
  thinking: { color: colors.textFaint, fontSize: font.small, fontStyle: 'italic', lineHeight: 18 },
  error: { color: colors.danger, fontSize: font.body },
  queue: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
});
