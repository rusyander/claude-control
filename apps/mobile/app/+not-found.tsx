import { Link, Stack } from 'expo-router';
import { StyleSheet } from 'react-native';
import { Muted, Screen, Title } from '../src/shared/ui';
import { colors, font, space } from '../src/shared/config/theme';

/** Экран несуществующего маршрута. Единственный выход отсюда — назад в разговор. */
export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Не найдено' }} />
      <Screen>
        <Title style={styles.title}>Такого экрана нет</Title>
        <Muted style={styles.text}>
          Ссылка ведёт в никуда — возможно, она осталась от прежней версии приложения.
        </Muted>
        <Link href="/" style={styles.link}>
          К разговору
        </Link>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  title: { paddingHorizontal: space.lg, paddingTop: space.lg },
  text: { paddingHorizontal: space.lg, paddingTop: space.xs },
  link: { color: colors.accent, fontSize: font.body, padding: space.lg },
});
