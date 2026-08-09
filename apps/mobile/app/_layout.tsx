import { useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import 'react-native-reanimated';
import { AppSplash } from '../src/features/splash/AppSplash';
import { loadConnection } from '../src/shared/api/connection';
import { loadWorkspace } from '../src/shared/lib/workspace';
import { resumeActive } from '../src/shared/lib/runs';
import { ensureChannel } from '../src/shared/lib/notifications';
import { colors } from '../src/shared/config/theme';
import { loadLanguage, useT } from '../src/shared/config/i18n';

export {
  // Ошибку в дереве навигации должен показывать экран, а не белый лист.
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = { initialRouteName: '(tabs)' };

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

  useEffect(() => {
    void (async () => {
      await Promise.all([loadConnection(), loadWorkspace(), loadLanguage(), ensureChannel()]);
      setReady(true);
      // Системная заставка гаснет растворением — стык с нашей не виден.
      SplashScreen.setOptions({ fade: true, duration: 220 });
      void SplashScreen.hideAsync();
      void resumeActive();
    })();
  }, []);

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
            <Stack.Screen name="chats" options={{ title: t.chats.title }} />
            <Stack.Screen name="code" options={{ title: t.code.projectTitle }} />
            <Stack.Screen name="tests" options={{ title: t.tests.screenTitle }} />
            <Stack.Screen name="pair" options={{ title: t.pair.screenTitle }} />
          </Stack>
          {greeted ? null : <AppSplash onDone={() => setGreeted(true)} />}
        </QueryClientProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}
