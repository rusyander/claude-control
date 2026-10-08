import { useEffect } from 'react';
import { View } from 'react-native';
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
import { RADIUS, TICKS } from './AppSplash.constants';
import type { AppSplashProps } from './AppSplash.types';
import { styles } from './AppSplash.styles';

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
