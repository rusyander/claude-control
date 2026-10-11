import { useContext, type ReactNode } from 'react';
import { ScrollView, View, type RefreshControlProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { HeaderShownContext } from 'expo-router/react-navigation';
import { styles } from './Screen.styles';

/**
 * Мелкий набор общих элементов. Не дизайн-система: ровно то, что повторяется на
 * каждом экране, — чтобы отступы и цвета не расползлись по месту применения.
 */

export function Screen({
  children,
  scroll,
  refreshControl,
}: {
  children: ReactNode;
  scroll?: boolean;
  refreshControl?: React.ReactElement<RefreshControlProps>;
}) {
  // Над экраном уже есть шапка навигатора — она сама отступила от выреза.
  // Второй отступ сверху давал пустую полосу высотой в строку состояния.
  const headerShown = useContext(HeaderShownContext);
  const content = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
      refreshControl={refreshControl}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={styles.flex}>{children}</View>
  );
  return (
    <SafeAreaView style={styles.screen} edges={headerShown ? [] : ['top']}>
      {content}
    </SafeAreaView>
  );
}
