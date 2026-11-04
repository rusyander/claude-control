import { StyleSheet } from 'react-native';
import { colors, font, radius, space } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  tool: { color: colors.warning },
  question: { color: colors.text, fontSize: font.body, lineHeight: 20 },
  hint: { color: colors.textDim, fontSize: font.small, lineHeight: 17 },
  failed: { color: colors.danger },
  grow: { flex: 1 },
});
