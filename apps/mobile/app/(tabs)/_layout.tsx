import { Tabs } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { colors } from '../../src/shared/config/theme';
import { useT } from '../../src/shared/config/i18n';

/**
 * Четыре вкладки — ровно то, ради чего приложение существует: разговор,
 * переключение проекта, аналитика и своя настройка. Остальные три десятка
 * разделов панели на телефон не переносятся: они настраивают конфигурацию, а
 * это работа за столом.
 */
export default function TabLayout() {
  const t = useT();
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        // Клавиатура открыта — вкладки не нужны и только отнимают строку у
        // переписки: набирают текст, а не переключают раздел.
        tabBarHideOnKeyboard: true,
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t.tabs.chat,
          headerShown: false,
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'bubble.left.and.bubble.right', android: 'chat', web: 'chat' }}
              tintColor={color}
              size={26}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="projects"
        options={{
          title: t.tabs.projects,
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'folder', android: 'folder', web: 'folder' }}
              tintColor={color}
              size={26}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="analytics"
        options={{
          title: t.tabs.analytics,
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'chart.bar', android: 'bar_chart', web: 'bar_chart' }}
              tintColor={color}
              size={26}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t.tabs.settings,
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'gearshape', android: 'settings', web: 'settings' }}
              tintColor={color}
              size={26}
            />
          ),
        }}
      />
      {/* Осталось от шаблона Expo: маршрут существует, но вкладкой не показывается. */}
      <Tabs.Screen name="two" options={{ href: null }} />
    </Tabs>
  );
}
