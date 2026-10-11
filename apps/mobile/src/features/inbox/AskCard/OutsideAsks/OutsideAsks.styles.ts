import { StyleSheet } from 'react-native';
import { colors, font, space } from '../../../../shared/config/theme';

export const styles = StyleSheet.create({
  box: { gap: space.sm },
  note: { color: colors.warning, fontSize: font.body, lineHeight: 20, fontWeight: '600' },
  question: { gap: space.xs },
  header: { color: colors.warning, fontSize: font.small, fontWeight: '700' },
  text: { color: colors.text, fontSize: font.body, lineHeight: 20 },
  option: { color: colors.text, fontSize: font.small, lineHeight: 18 },
  description: { color: colors.textDim },
});
