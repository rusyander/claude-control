import { StyleSheet } from 'react-native';
import { colors, space, font } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  root: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    padding: space.sm,
    gap: space.sm,
  },
  notice: { alignItems: 'flex-start', paddingHorizontal: space.xs },
  noticeText: { color: colors.textDim, fontSize: font.small + 1, lineHeight: 18, flex: 1 },
  message: { alignItems: 'center', paddingHorizontal: space.xs },
  messageText: { color: colors.text, fontSize: font.small + 1, flex: 1 },
  waiting: { color: colors.warning, fontSize: font.small },
  delivered: { color: colors.success, fontSize: font.small },
  warn: { color: colors.warning, fontSize: font.small, paddingHorizontal: space.xs },
  failed: { color: colors.danger, fontSize: font.small, paddingHorizontal: space.xs },
  bar: { alignItems: 'flex-end' },
  input: { flex: 1, minHeight: 52 },
  send: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  sendOff: { opacity: 0.4 },
  pressed: { opacity: 0.75 },
});
