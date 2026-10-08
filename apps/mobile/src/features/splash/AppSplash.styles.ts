import { StyleSheet } from 'react-native';
import {
  FILL,
  SPLASH_BACKGROUND,
  RADIUS,
  TICK_WIDTH,
  TICK_LENGTH,
  DOT,
} from './AppSplash.constants';

export const styles = StyleSheet.create({
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
