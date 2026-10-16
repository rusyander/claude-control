import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import 'react-native-reanimated';
import { AppSplash } from '../src/features/splash/AppSplash';
import { currentConnection, useConnection, loadConnection } from '../src/shared/api/connection';
import { forgetPanelData } from '../src/shared/api/panel-cache';
import { resumeActive } from '../src/shared/lib/runs';
import { useNotificationOpen } from '../src/shared/lib/notifications';
import { notificationTarget } from '../src/entities/provider-chat/model';
import { colors } from '../src/shared/config/theme';
import { useT, loadLanguage } from '../src/shared/config/i18n';
import { ensureChannel } from '../src/shared/lib/ensureChannel';
import { loadWorkspace, openChat } from '../src/shared/lib/workspace';
import { activatePanel, panelForMachine, refreshIdentity } from '../src/shared/lib/panel-switch';

export {
  // Ошибку в дереве навигации должен показывать экран, а не белый лист.
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = { initialRouteName: '(tabs)' };

/** Как часто спрашивать сервер о чужих прогонах — как панель: ответ из памяти, не с диска. */
const ADOPT_INTERVAL_MS = 5_000;

SplashScreen.preventAutoHideAsync();

/**
 * Корень приложения.
 *
 * Главное здесь — возвращение из фона. Телефон выгружает вкладку и рвёт потоки,
 * поэтому «что сейчас происходит» приложение узнаёт не из своей памяти, а
 * спрашивая сервер заново: прогоны там живут независимо от клиента, и пока
 * экран был погашен, работа могла и начаться, и закончиться.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnMount: true,
      refetchOnWindowFocus: false,
    },
  },
});

export default function RootLayout() {
  const t = useT();
  const [ready, setReady] = useState(false);
  // Заставка своя, поверх системной: та показывает знак неподвижно, эта его
  // оживляет и уходит. Приложение под ней уже смонтировано и готово.
  const [greeted, setGreeted] = useState(false);
  const appState = useRef<AppStateStatus>(AppState.currentState);
  const connection = useConnection();

  // Нажатие на уведомление — в его разговор: чужой CLI открывается своим экраном,
  // разговор Claude — обычным чатом своего проекта. Уведомление с другого
  // компьютера сначала выбирает его: разговор живёт на той машине.
  const openFromNotification = useCallback(async (data: unknown) => {
    const target = notificationTarget(data);
    if (!target) return;
    const panel = panelForMachine((data as { machineId?: unknown } | null)?.machineId);
    if (panel) await activatePanel(panel);
    if (target.kind === 'foreign') {
      router.push({
        pathname: '/foreign-chat',
        params: { provider: target.providerId, id: target.chatId },
      });
      return;
    }
    openChat(target.chatId, target.projectPath || undefined);
    router.push('/chat');
  }, []);
  // Ждёт, пока смонтирован стек и показана заставка: раньше переходить некуда.
  const onNotification = useCallback(
    (data: unknown) => void openFromNotification(data),
    [openFromNotification],
  );
  useNotificationOpen(onNotification, ready && greeted);

  useEffect(() => {
    void (async () => {
      await Promise.all([loadConnection(), loadLanguage(), ensureChannel()]);
      await loadWorkspace(currentConnection().activeId);
      setReady(true);
      // Системная заставка гаснет растворением — стык с нашей не виден.
      SplashScreen.setOptions({ fade: true, duration: 220 });
      void SplashScreen.hideAsync();
      // Имя машины могли сменить, а старая пара его не знала вовсе.
      void refreshIdentity();
    })();
  }, []);

  // Кэш запросов принадлежит одной панели: после смены компьютера, «Забыть» или
  // спаривания экраны иначе показывают данные прежней, пока каждый не перезапросится
  // сам. Идущие на выбранной машине прогоны подхватываются тут же, без ожидания опроса.
  useEffect(() => {
    void forgetPanelData(queryClient);
    void resumeActive();
  }, [connection.activeId, connection.url]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      const returned = /inactive|background/.test(appState.current) && next === 'active';
      appState.current = next;
      if (!returned) return;
      void resumeActive();
      void queryClient.invalidateQueries();
    });
    return () => subscription.remove();
  }, []);

  // Раз при входе и при возвращении из фона мало: ход начинают и с компьютера,
  // и из терминала — ПОСЛЕ того, как приложение открылось. Своего события у
  // чужого хода нет, сервер рассказывает о нём только тому, кто спросил, —
  // поэтому спрашиваем, пока экран активен. Уже известные прогоны опрос не
  // трогает (`attach` отсеивает их по `startedAt`).
  useEffect(() => {
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void resumeActive();
    }, ADOPT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  if (!ready) return null;

  return (
    <SafeAreaProvider>
      {/* Клавиатура — общая забота всего приложения: провайдер должен стоять
          выше любого экрана с полем ввода, иначе его `KeyboardAvoidingView`
          молча ничего не делает. */}
      <KeyboardProvider>
        <QueryClientProvider client={queryClient}>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: colors.surface },
              headerTintColor: colors.text,
              contentStyle: { backgroundColor: colors.bg },
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="chat" options={{ headerShown: false }} />
            <Stack.Screen name="chats" options={{ title: t.chats.title }} />
            <Stack.Screen name="project" options={{ title: '' }} />
            <Stack.Screen name="foreign-chat" options={{ title: '' }} />
            <Stack.Screen name="code" options={{ title: t.code.projectTitle }} />
            <Stack.Screen name="tests" options={{ title: t.tests.screenTitle }} />
            <Stack.Screen name="test-run" options={{ title: t.tests.manual.title }} />
            <Stack.Screen name="test-runs" options={{ title: t.tests.runs.title }} />
            <Stack.Screen name="pair" options={{ title: t.pair.screenTitle }} />
          </Stack>
          {greeted ? null : <AppSplash onDone={() => setGreeted(true)} />}
        </QueryClientProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}
