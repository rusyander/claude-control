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
import type { ChatMessage } from '@agentdeck/contracts';
import { Empty, Loading, Mono, Row, StatusDot } from '../src/shared/ui';
import { colors, font, space } from '../src/shared/config/theme';
import { useT } from '../src/shared/config/i18n';
import { useConnection, isConfigured } from '../src/shared/api/connection';
import { useWorkspace, newChatId, openChat } from '../src/shared/lib/workspace';
import {
  cancelQueued,
  restoreQueue,
  quietRun,
  send,
  stop,
  useRun,
  useRunKey,
  visibleStatus,
} from '../src/shared/lib/runs';
import { ChatGroupNotes } from '../src/features/chat/ChatGroupNotes/ChatGroupNotes';
import { useCostUnit } from '../src/entities/settings/api';
import { Composer } from '../src/features/chat/Composer/Composer';
import { MediaImageCard } from '../src/features/chat/MediaImageCard/MediaImageCard';
import { useImageMode } from '../src/features/chat/useImageMode';
import { Markdown } from '../src/features/chat/Markdown/Markdown';
import { AgentText } from '../src/features/chat/AgentText/AgentText';
import { PermissionCard } from '../src/features/chat/PermissionCard/PermissionCard';
import { Progress } from '../src/features/chat/Progress/Progress';
import { TokenBadge } from '../src/features/chat/TokenBadge/TokenBadge';
import { ToolCall } from '../src/features/chat/ToolCall/ToolCall';
import { RunTimer } from '../src/features/chat/RunTimer/RunTimer';
import { liveToolsOutsideHistory } from '../src/features/chat/liveTurn';
import { Transcript } from '../src/features/chat/Transcript/Transcript';
import { AskCard } from '../src/features/inbox/AskCard/AskCard';
import { useSent } from '../src/features/inbox/sent';
import { useInboxChats } from '../src/features/inbox/useInboxChats';
import { chatMessagesQuery } from '../src/entities/chat/chatMessagesQuery';
import { useChatMessages } from '../src/entities/chat/useChatMessages';
import { useChatProgress } from '../src/entities/chat/useChatProgress';
import { inboxChatNamed } from '../src/entities/inbox/inboxChatNamed';
import { visibleAsks } from '../src/entities/inbox/visibleAsks';
import { shortModel } from '../src/shared/lib/shortModel';
import { formatSpend } from '../src/shared/lib/formatSpend';
import type { ComposerValue } from '../src/features/chat/Composer/Composer.types';
import { UserBubble } from '../src/features/chat/UserBubble/UserBubble';

/**
 * Разговор — то, ради чего приложение существует: видеть, что делает агент,
 * отвечать на его вопросы и ставить новую задачу с телефона, пока он работает
 * на машине дома.
 *
 * Лента склеена из двух источников, и это не небрежность. Прошлое приходит из
 * транскрипта (сервер уже разложил его по сообщениям), настоящее — из живого
 * потока, где транскрипт ещё не дописан. Сводить их в одну структуру пришлось бы
 * через третье представление, которого нет ни у сервера, ни у потока.
 *
 * Экран стека, а не вкладка: первой вкладкой стала сводка «что идёт и кто
 * ждёт», из неё и из списка разговоров сюда приходят одним нажатием, а стрелка
 * в шапке возвращает туда, откуда пришли.
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
  // Прогон — под любым именем разговора: ход со стола или разделения идёт под
  // `new-…`, а открыт разговор мог быть по сессии (список, прошлое открытие).
  const runKey = useRunKey(chatId);
  const run = useRun(runKey);

  // Очередь дописанного пережила перезапуск приложения: досылаем, если агент
  // свободен, иначе показываем — она уйдёт по концу хода.
  useEffect(() => {
    if (chatId) void restoreQueue(chatId);
  }, [chatId]);
  const status = visibleStatus(run);
  const isRunning = run.status === 'running';

  // Транскрипт живёт под сессией. Разговор, открытый по ключу прогона `new-…`
  // (строка главной во время хода со стола), читает историю по сессии, которую
  // прогон уже знает, — иначе экран пуст, пока ход не кончится.
  const transcriptId = isDraft(chatId) && run.sessionId ? run.sessionId : chatId;
  const messages = useChatMessages(transcriptId);
  const progress = useChatProgress(run.sessionId ?? transcriptId, isRunning);
  // Вопрос агента — той же карточкой, что во «Вопросах», и из той же сводки:
  // ответ уходит одним путём, отправленное скрыто в обоих местах.
  const inbox = useInboxChats(isConfigured(connection));
  const sentAnswers = useSent();
  const inboxRow = inboxChatNamed(inbox.data ?? [], runKey, run.sessionId, chatId);
  const questionAsks = inboxRow
    ? visibleAsks(inboxRow, sentAnswers).filter((ask) => ask.kind === 'question')
    : [];
  // Единицы расхода выбираются один раз в самой панели — телефон им следует.
  const costUnit = useCostUnit();

  const [value, setValue] = useState<ComposerValue>({
    text: '',
    allowEdits: true,
    // Авторежим не задан: сервер возьмёт выбор этого чата или глобальную
    // настройку панели. Явное `true` здесь каждой отправкой перекрывало бы
    // выключенное в панели — телефон решал бы за человека.
    model: '',
    effort: '',
    files: [],
  });
  // Выбор авторежима принадлежит чату: переход в другой разговор его снимает,
  // иначе первая же отправка там записала бы чужой выбор новому чату.
  useEffect(() => {
    setValue((current) =>
      current.autoApprove === undefined ? current : { ...current, autoApprove: undefined },
    );
  }, [chatId]);
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

      // Работа продолжена чистой сессией — уходим в новый разговор, как вкладка
      // панели: оставаться на закрытом значило бы смотреть на его конец, пока
      // агент работает в другом месте. Сам прогон подхватит опрос `/chat/active`.
      const handoffTo = run.handoffTo;
      const sessionId = run.sessionId;
      if (handoffTo) {
        openChat(handoffTo, run.projectPath ?? workspace.projectPath);
      } else if (sessionId && sessionId !== chatId && isDraft(chatId)) {
        void queryClient
          .fetchQuery(chatMessagesQuery(sessionId))
          .then(() => openChat(sessionId))
          .catch(() => undefined);
      }
    }
    wasRunning.current = isRunning;
  }, [
    isRunning,
    queryClient,
    chatId,
    run.sessionId,
    run.handoffTo,
    run.projectPath,
    workspace.projectPath,
  ]);

  // Лента перечиталась уже после конца хода и ответ в ней есть — значит поток
  // договорил своё и обязан замолчать: иначе один и тот же ответ стоит на
  // экране дважды, из транскрипта и из потока.
  const messagesUpdatedAt = messages.dataUpdatedAt;
  useEffect(() => {
    if (isRunning || !run.text) return;
    if (!finishedAt.current || messagesUpdatedAt <= finishedAt.current) return;
    if (!messages.data?.messages.some((message) => message.role === 'assistant')) return;
    quietRun(runKey);
  }, [messagesUpdatedAt, messages.data, isRunning, run.text, runKey]);

  const image = useImageMode(chatId);

  /** Отправить агенту текст. Истина — сервер сообщение принял. */
  const dispatch = useCallback(
    (prompt: string): Promise<boolean> =>
      send({
        // Агент занят — сообщение встаёт в очередь того прогона, что идёт, под
        // его ключом; свободен — уходит под именем открытого разговора.
        chatId: run.status === 'running' ? runKey : chatId,
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
      }).then((outcome) => {
        if (!outcome.ok) setFailed(outcome.message);
        return outcome.ok;
      }),
    [chatId, runKey, run.status, run.sessionId, value, workspace.projectPath],
  );

  const onSend = useCallback(() => {
    const prompt = value.text.trim();
    if (!prompt) return;
    setFailed('');
    // Режим «Картинка»: дорогу решает план сервера — панель рисует сама (файл и
    // карточка) или просит агента обычным сообщением, собранным сервером.
    if (image.mode === 'image') {
      void image.submit(prompt, dispatch).then((road) => {
        // Вложения уехали только с сообщением агенту; панели, рисующей самой,
        // они не нужны — и стирать их тогда нельзя.
        if (road === 'agent') setValue((state) => ({ ...state, text: '', files: [] }));
        if (road === 'image') setValue((state) => ({ ...state, text: '' }));
      });
      return;
    }
    setBusy(true);
    void dispatch(prompt)
      .then((ok) => {
        // Поле очищается, только когда сервер ПРИНЯЛ сообщение: иначе отказ
        // уничтожает набранный текст и печатать приходится заново.
        if (ok) setValue((state) => ({ ...state, text: '', files: [] }));
      })
      .finally(() => setBusy(false));
  }, [value.text, dispatch, image]);

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
  // Чат, открытый посреди хода, уже видит его шаги в транскрипте: поток их не повторяет.
  const liveTools = liveToolsOutsideHistory(history, run.tools, run.startedAt);
  const isBlank = history.length === 0 && !run.text && !run.thinking && !isRunning;
  // Транскрипт перечитывается только по окончании хода, поэтому своя задача
  // показывается из состояния прогона — и убирается, как только доехала лента.
  const sent =
    run.lastPrompt && run.status !== 'idle' && !inHistory(history, run.lastPrompt)
      ? run.lastPrompt
      : '';

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Row gap={space.sm} style={styles.headerMain}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.home.back}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            hitSlop={8}
            style={styles.back}
          >
            <Text style={styles.backText}>‹</Text>
          </Pressable>
          <StatusDot status={status} />
          <Text style={styles.project} numberOfLines={1}>
            {projectName}
          </Text>
        </Row>
        <Row gap={space.xs}>
          {/* Чем ведут прогон. Имя приходит от самого CLI (событие `session`), а
              не из того, что телефон отправил: по умолчанию он не шлёт ничего, а
              чат, заведённый разделением, панель ведёт подобранной моделью — и
              без этой подписи на телефоне не видно, слабее она потолка или нет. */}
          {run.model ? (
            <Text style={styles.model} numberOfLines={1}>
              {shortModel(run.model)}
            </Text>
          ) : null}
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

      {/* Вкладок под экраном стека нет, а нижний системный отступ уже взял
          `SafeAreaView`: смещение считается от рамки этого блока, и лишнее
          оставило бы под полем пустую полосу. */}
      <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={0}>
        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.feed}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
          keyboardShouldPersistTaps="handled"
        >
          {messages.isLoading ? <Loading /> : null}
          {isDraft(transcriptId) ? null : (
            <ChatGroupNotes
              chatId={transcriptId}
              {...(run.sessionId ? { sessionId: run.sessionId } : {})}
            />
          )}
          <Transcript messages={history} costUnit={costUnit} isRunning={isRunning} />

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

          {liveTools.map((tool, index) => (
            <ToolCall key={tool.id ?? `tool-${index}`} tool={tool} costUnit={costUnit} />
          ))}

          {/* Тот же разбор, что у транскрипта: рисунок агента — карточкой уже
              в потоке, недописанный блок спрятан, пока ответ печатается. */}
          {run.text ? <AgentText text={run.text} streaming={isRunning} /> : null}
          {/* Расход ответа виден сразу, а не только после того, как ход
              закончится и лента перечитается из транскрипта. */}
          {run.text && run.textUsage ? (
            <TokenBadge usage={run.textUsage} unit={costUnit} label={t.chat.usage.answer} />
          ) : null}
          {/* Живой таймер прогона: сколько агент уже работает над этим ходом. */}
          {isRunning && run.startedAt !== undefined ? <RunTimer since={run.startedAt} /> : null}

          {run.permissions.map((permission) => (
            <PermissionCard key={permission.toolUseId} chatId={runKey} permission={permission} />
          ))}

          {inboxRow && questionAsks.length > 0 ? (
            <AskCard chat={inboxRow} asks={questionAsks} now={Date.now()} />
          ) : null}

          {run.error ? <Text style={styles.error}>{run.error}</Text> : null}
          {/* Мёртвый сокет неотличим от думающего агента — говорим словами. */}
          {run.stalled ? <Text style={styles.thinking}>{t.run.reconnecting}</Text> : null}
          {failed ? <Text style={styles.error}>{failed}</Text> : null}

          {isBlank ? <Empty text={t.chat.blank} /> : null}
        </ScrollView>

        {(run.steered?.length ?? 0) > 0 || run.queued.length > 0 ? (
          <View style={styles.queue}>
            {(run.steered ?? []).map((prompt) => (
              <Mono key={`steered-${prompt}`} numberOfLines={1}>
                {t.chat.steered(prompt)}
              </Mono>
            ))}
            {run.queued.map((item) => (
              <Pressable key={item.id} onPress={() => cancelQueued(runKey, item.id)}>
                <Mono numberOfLines={1}>{t.chat.queued(item.prompt)}</Mono>
              </Pressable>
            ))}
          </View>
        ) : null}

        <Progress progress={progress.data} isRunning={isRunning} />

        {image.shown ? <MediaImageCard image={image.shown} onClose={image.close} /> : null}

        <Composer
          chatId={chatId}
          sessionId={run.sessionId ?? (isDraft(chatId) ? undefined : chatId)}
          image={image}
          value={value}
          onChange={setValue}
          onSend={onSend}
          onStop={() => void stop(runKey)}
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
  back: { paddingRight: space.xs },
  backText: { color: colors.accent, fontSize: 26, lineHeight: 28 },
  project: { color: colors.text, fontSize: font.title, fontWeight: '600', flex: 1 },
  spend: { color: colors.textFaint, fontSize: font.small, fontFamily: font.mono },
  model: { color: colors.textFaint, fontSize: font.small, fontFamily: font.mono, maxWidth: 120 },
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
