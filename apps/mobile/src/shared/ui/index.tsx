import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type RefreshControlProps,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, font, radius, space } from '../config/theme';

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
    <SafeAreaView style={styles.screen} edges={['top']}>
      {content}
    </SafeAreaView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Title({
  children,
  style,
  numberOfLines,
}: {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  return (
    <Text style={[styles.title, style]} numberOfLines={numberOfLines}>
      {children}
    </Text>
  );
}

export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.muted, style]}>{children}</Text>;
}

export function Body({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.body, style]}>{children}</Text>;
}

export function Mono({
  children,
  style,
  numberOfLines,
}: {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  return (
    <Text style={[styles.mono, style]} numberOfLines={numberOfLines}>
      {children}
    </Text>
  );
}

export function Button({
  title,
  onPress,
  tone = 'default',
  disabled,
  busy,
  style,
}: {
  title: string;
  onPress: () => void;
  tone?: 'default' | 'accent' | 'danger' | 'ghost';
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const toneStyle =
    tone === 'accent'
      ? styles.buttonAccent
      : tone === 'danger'
        ? styles.buttonDanger
        : tone === 'ghost'
          ? styles.buttonGhost
          : styles.buttonDefault;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        toneStyle,
        (disabled || busy) && styles.buttonDisabled,
        pressed && styles.buttonPressed,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={colors.text} size="small" />
      ) : (
        <Text style={styles.buttonText}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Field({
  value,
  onChangeText,
  placeholder,
  multiline,
  autoCapitalize = 'none',
  secure,
  style,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  autoCapitalize?: 'none' | 'sentences';
  secure?: boolean;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.textFaint}
      multiline={multiline}
      autoCapitalize={autoCapitalize}
      autoCorrect={false}
      secureTextEntry={secure}
      style={[styles.field, multiline && styles.fieldMultiline, style]}
    />
  );
}

/** Точка статуса прогона — те же смыслы, что в панели. */
export function StatusDot({ status }: { status: string }) {
  const color =
    status === 'running'
      ? colors.running
      : status === 'waiting'
        ? colors.waiting
        : status === 'error'
          ? colors.danger
          : status === 'done'
            ? colors.success
            : colors.textFaint;
  return <View style={[styles.dot, { backgroundColor: color }]} />;
}

export function Empty({ text }: { text: string }) {
  return (
    <View style={styles.empty}>
      <Muted style={styles.emptyText}>{text}</Muted>
    </View>
  );
}

export function Loading() {
  return (
    <View style={styles.empty}>
      <ActivityIndicator color={colors.accent} />
    </View>
  );
}

export function Row({
  children,
  gap = space.sm,
  style,
}: {
  children: ReactNode;
  gap?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.row, { gap }, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.bg },
  scrollContent: { padding: space.lg, gap: space.md },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
    gap: space.sm,
  },
  title: { color: colors.text, fontSize: font.title, fontWeight: '600' },
  body: { color: colors.text, fontSize: font.body, lineHeight: 20 },
  muted: { color: colors.textDim, fontSize: font.small },
  mono: { color: colors.textDim, fontSize: font.small, fontFamily: font.mono },
  button: {
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
  },
  buttonDefault: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  buttonAccent: { backgroundColor: colors.accent },
  buttonDanger: { backgroundColor: colors.danger },
  buttonGhost: { backgroundColor: 'transparent' },
  buttonDisabled: { opacity: 0.45 },
  buttonPressed: { opacity: 0.75 },
  buttonText: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  field: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    color: colors.text,
    fontSize: font.body,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
  fieldMultiline: { minHeight: 44, maxHeight: 140, textAlignVertical: 'top' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  empty: { padding: space.xl, alignItems: 'center', justifyContent: 'center' },
  emptyText: { textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center' },
});
