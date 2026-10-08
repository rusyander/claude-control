import type { ReactNode } from 'react';
import { View } from 'react-native';
import { styles } from '../Transcript/Transcript.styles';

/**
 * Пузырь своего сообщения отдельно от ленты: пока прогон идёт, транскрипт ещё
 * не дописан, и отправленная задача иначе исчезает с экрана до самого конца
 * работы — человек не видит, что именно он послал.
 */
export function UserBubble({ children }: { children: ReactNode }) {
  return <View style={[styles.message, styles.user]}>{children}</View>;
}
