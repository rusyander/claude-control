import * as Linking from 'expo-linking';
import type { ReactNode } from 'react';
import { Pressable, type PressableProps } from 'react-native';

/**
 * Ссылка наружу — в системный браузер через `expo-linking`, который в сборке
 * есть. Шаблон Expo открывал её через `expo-web-browser`, но этой зависимости
 * в приложении нет, а типизированные маршруты `expo-router` не принимают
 * произвольную строку в `href` — файл ломал проверку типов. Компонент остался
 * от шаблона и экранами не используется; удаление не согласовано.
 */
export function ExternalLink({
  href,
  children,
  ...props
}: Omit<PressableProps, 'onPress' | 'children'> & { href: string; children?: ReactNode }) {
  return (
    <Pressable {...props} accessibilityRole="link" onPress={() => void Linking.openURL(href)}>
      {children}
    </Pressable>
  );
}
