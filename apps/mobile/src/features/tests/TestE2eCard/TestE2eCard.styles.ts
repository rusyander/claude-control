import { StyleSheet } from 'react-native';
import { colors, font, space } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  run: { marginTop: space.xs },
  outcome: { color: colors.text, fontSize: font.small },
  danger: { color: colors.danger },
  warning: { color: colors.warning },
  success: { color: colors.success },
});
