import { StyleSheet } from 'react-native';
import { space, colors, font } from '../../shared/config/theme';

export const styles = StyleSheet.create({
  root: { gap: space.sm },
  grow: { flex: 1 },
  wrap: { flexWrap: 'wrap' },
  added: { color: colors.success },
  removed: { color: colors.danger },
  warn: { color: colors.warning },
  toggle: { color: colors.accent, fontSize: font.small },
  image: { width: '100%', height: 240, backgroundColor: colors.surface },
  code: { backgroundColor: colors.surface, borderRadius: 6 },
  codeContent: { padding: space.sm },
  line: { color: colors.text, fontFamily: font.mono, fontSize: font.small, lineHeight: 17 },
  lineAdded: { color: colors.success },
  lineRemoved: { color: colors.danger },
});
