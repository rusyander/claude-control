import { StyleSheet } from 'react-native';
import { space, radius, colors, font } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  root: { gap: space.md },
  message: {
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
    borderWidth: 1,
  },
  user: {
    backgroundColor: colors.accentDim,
    borderColor: colors.accentDim,
    alignSelf: 'flex-end',
    maxWidth: '92%',
  },
  assistant: { backgroundColor: colors.surface, borderColor: colors.border },
  toolsOnly: { gap: space.xs, marginVertical: -space.xs },
  thinking: { color: colors.textFaint, fontSize: font.small, fontStyle: 'italic', lineHeight: 18 },
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  tool: { color: colors.accent, fontSize: font.small, fontFamily: font.mono },
  toolError: { color: colors.danger },
  summarized: { color: colors.warning, fontSize: font.small, lineHeight: 18 },
  toolSummary: { color: colors.textFaint, fontSize: font.small, fontFamily: font.mono, flex: 1 },
  notice: { gap: space.xs, paddingHorizontal: space.sm },
  noticeText: { color: colors.textDim, fontSize: font.small, lineHeight: 18 },
});
