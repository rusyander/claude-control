import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Muted } from '../../shared/ui';
import { colors, font, space } from '../../shared/config/theme';
import { useT } from '../../shared/config/i18n';
import {
  confluencePageUrl,
  jiraIssueUrl,
  useAtlassianSettings,
  useIntegrationLinks,
} from '../../entities/integrations/api';

/**
 * Что этот проект связывает с внешним миром: задача и страница требований.
 *
 * Только чтение и только открытие в браузере. Правят привязку в панели: на
 * телефоне нет ни токенов, ни поиска по трекеру, а нужен он ровно затем, чтобы
 * стоя у стенда открыть требования и посмотреть, как оно должно работать.
 *
 * Привязка группы перекрывает проектную: набор «Оплата» может вестись в другом
 * эпике, и знать это надо до того, как отмечаешь провал.
 */
export function TestLinks({ projectPath, groupId }: { projectPath: string; groupId?: string }) {
  const t = useT();
  const atlassian = useAtlassianSettings();
  const links = useIntegrationLinks(projectPath);

  const link = (groupId ? links.data?.groups?.[groupId] : undefined) ?? links.data?.project;
  if (!link) return null;

  const rows = [
    {
      key: 'issue',
      label: t.tests.links.issue,
      text: link.jiraIssueKey
        ? `${link.jiraIssueKey}${link.jiraIssueTitle ? ` · ${link.jiraIssueTitle}` : ''}`
        : '',
      url: jiraIssueUrl(atlassian, link.jiraIssueKey),
    },
    {
      key: 'page',
      label: t.tests.links.page,
      text: link.confluencePageTitle ?? link.confluencePageId ?? '',
      url: confluencePageUrl(atlassian, link.confluencePageId),
    },
  ].filter((row) => row.text);

  if (rows.length === 0) return null;

  return (
    <View style={styles.box}>
      <Muted>{t.tests.links.title}</Muted>
      {rows.map((row) => (
        <Pressable
          key={row.key}
          onPress={() => row.url && void Linking.openURL(row.url)}
          disabled={!row.url}
          style={styles.row}
        >
          <Text style={styles.label}>{row.label}</Text>
          <Text style={[styles.text, row.url ? styles.link : undefined]} numberOfLines={2}>
            {row.text}
          </Text>
        </Pressable>
      ))}
      {link.note ? <Muted>{link.note}</Muted> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: space.xs },
  row: { flexDirection: 'row', gap: space.xs, alignItems: 'flex-start' },
  label: { color: colors.textDim, fontSize: font.small },
  text: { color: colors.text, fontSize: font.small, flex: 1 },
  link: { color: colors.accent, textDecorationLine: 'underline' },
});
