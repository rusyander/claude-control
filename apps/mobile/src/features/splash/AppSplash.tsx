import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
// Возврат с потока анимации в обычный: `runOnJS` в Reanimated 4 объявлен
// устаревшим, замена живёт в самих worklets.
import { scheduleOnRN } from 'react-native-worklets';

/**
 * Заставка при запуске — продолжение системной, а не вторая.
 *
 * Знак приложения тот же, что у панели в браузере: кольцо с делениями и точка
 * отсчёта. Системная заставка показывает его неподвижным, эта подхватывает с
 * той же позиции и оживляет — кольцо доворачивается, точка встаёт на место,
 * после чего всё уходит вверх и растворяется, открывая приложение. Стыка не
 * видно: фон и размер знака совпадают с `splash-icon.png`.
 *
 * Кольцо собрано из отдельных делений, а не нарисовано пунктирной рамкой:
 * Android рисует `borderStyle: 'dashed'` на скруглённой рамке сплошной линией,
 * и знак переставал быть похож на себя.
 */
export const SPLASH_BACKGROUND = '#4f46e5';

/**
 * Размеры — те же доли радиуса, что в `favicon.svg` и в
 * `tools/make-mobile-icons.mjs`: штрих 0.235 радиуса, деление 0.4, точка 0.376.
 * Делений семь — столько укладывается по окружности при таком шаге.
 */
const RADIUS = 62;
const TICKS = 7;
const TICK_LENGTH = Math.round(RADIUS * 0.4);
const TICK_WIDTH = Math.round(RADIUS * 0.235);
const DOT = Math.round(RADIUS * 0.376) * 2;

export interface AppSplashProps {
  /** Заставка договорила — можно показывать приложение. */
  onDone: () => void;
}

export function AppSplash({ onDone }: AppSplashProps) {
  const spin = useSharedValue(0);
  const dot = useSharedValue(0.3);
  const fade = useSharedValue(1);
  const lift = useSharedValue(0);

  useEffect(() => {
    spin.value = withTiming(1, { duration: 1000, easing: Easing.out(Easing.cubic) });
    dot.value = withDelay(
      140,
      withTiming(1, { duration: 420, easing: Easing.out(Easing.back(2)) }),
    );
    lift.value = withDelay(820, withTiming(1, { duration: 320, easing: Easing.in(Easing.cubic) }));
    fade.value = withDelay(
      820,
      withTiming(0, { duration: 320 }, (finished) => {
        'worklet';
        // Приложение показываем ТОЛЬКО после конца анимации: иначе первый кадр
        // ленты проступает сквозь ещё непрозрачную заставку.
        if (finished) scheduleOnRN(onDone);
      }),
    );
    // Значения общие для всего времени жизни экрана — перезапускать нечего.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const screenStyle = useAnimatedStyle(() => ({
    opacity: fade.value,
    transform: [{ translateY: -18 * lift.value }, { scale: 1 + 0.12 * lift.value }],
  }));

  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${-120 + 120 * spin.value}deg` }],
  }));

  const dotStyle = useAnimatedStyle(() => ({
    transform: [{ scale: dot.value }],
    opacity: dot.value,
  }));

  return (
    <Animated.View style={[styles.screen, screenStyle]} pointerEvents="none">
      <View style={styles.mark}>
        <Animated.View style={[styles.ring, ringStyle]}>
          {Array.from({ length: TICKS }, (_, index) => (
            <View
              key={index}
              style={[
                styles.tick,
                {
                  // Сначала поворот, потом вынос наружу: длинная сторона
                  // деления оказывается ВДОЛЬ окружности, а не лучом от центра.
                  transform: [{ rotate: `${(360 / TICKS) * index}deg` }, { translateY: -RADIUS }],
                },
              ]}
            />
          ))}
        </Animated.View>
        <Animated.View style={[styles.dot, dotStyle]} />
      </View>
    </Animated.View>
  );
}

/** Растянуть на весь родитель: типы RN больше не отдают готовый объект. */
const FILL = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } as const;

const styles = StyleSheet.create({
  screen: {
    ...FILL,
    backgroundColor: SPLASH_BACKGROUND,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mark: {
    width: RADIUS * 2 + TICK_WIDTH,
    height: RADIUS * 2 + TICK_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: { ...FILL, alignItems: 'center', justifyContent: 'center' },
  tick: {
    position: 'absolute',
    width: TICK_LENGTH,
    height: TICK_WIDTH,
    borderRadius: TICK_WIDTH / 2,
    backgroundColor: 'rgba(255, 255, 255, 0.75)',
  },
  dot: {
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    backgroundColor: '#ffffff',
  },
});
