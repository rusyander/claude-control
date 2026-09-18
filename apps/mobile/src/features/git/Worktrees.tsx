import { StyleSheet, Text, View } from 'react-native';
import { Card, Loading, Mono, Muted, Row, Title } from '../../shared/ui';
import { colors, font, radius, space } from '../../shared/config/theme';
import { useT } from '../../shared/config/i18n';
import { useProjectWorktrees } from '../../entities/project/api';
import { copyFacts, visibleCopies } from './copy-facts';
import { serverField } from '../../shared/api/server-message';

/**
 * Параллельные копии проекта — только чтение.
 *
 * Заводить и удалять копии с телефона нельзя намеренно: обе операции трогают
 * файлы на машине и стоят дорого при ошибке. А вот ЗНАТЬ, что копия неполная,
 * человеку нужно именно на телефоне: отказ запуска (422) приходит в чат, и без
 * этой карточки причина отказа выглядела бы как поломка панели.
 *
 * Полноту копии панель сверяет заново перед каждым прогоном и пробует добрать
 * сама — поэтому кнопки «Добрать» тут нет: телефон показывает состояние, а
 * чинит его тот, кто запускает.
 */
export function Worktrees({ projectPath }: { projectPath: string }) {
  const t = useT();
  const worktrees = useProjectWorktrees(projectPath);

  if (worktrees.isLoading) return <Loading />;
  const info = worktrees.data;
  if (!info?.isRepo) return null;
  if (info.error) {
    return (
      <Card>
        <Title>{t.worktrees.title}</Title>
        <Mono style={styles.failed}>{serverField(info, 'error')}</Mono>
      </Card>
    );
  }

  const copies = visibleCopies(info);
  if (copies.length === 0) return null;

  return (
    <Card>
      <Row gap={space.sm}>
        <Title style={styles.grow}>{t.worktrees.title}</Title>
        <Muted>{t.worktrees.count(copies.length)}</Muted>
      </Row>
      {copies.map((copy) => (
        <View key={copy.path} style={styles.item}>
          <Row gap={space.sm}>
            <Mono style={styles.grow} numberOfLines={1}>
              {copy.detached ? t.worktrees.detached : (copy.branch ?? '—')}
            </Mono>
            {copy.copy ? (
              <Text style={[styles.badge, copy.copy.ready ? styles.ready : styles.notReady]}>
                {copy.copy.ready ? t.worktrees.ready : t.worktrees.notReady}
              </Text>
            ) : null}
          </Row>
          <Mono style={styles.path} numberOfLines={2}>
            {copy.path}
          </Mono>
          <Muted>{copyFacts(copy, t).join(' · ')}</Muted>
          {copy.copy && !copy.copy.ready
            ? copy.copy.gaps.map((gap) => (
                <Mono key={`${gap.kind}:${gap.path}`} style={styles.gap} numberOfLines={1}>
                  {t.worktrees.gap[gap.kind](gap.path)}
                </Mono>
              ))
            : null}
          {copy.bootstrap && copy.bootstrap.status !== 'ok' ? (
            <Mono style={styles.failed} numberOfLines={3}>
              {copy.bootstrap.status === 'running'
                ? t.worktrees.bootstrapRunning(copy.bootstrap.command)
                : t.worktrees.bootstrapFailed(copy.bootstrap.command)}
            </Mono>
          ) : null}
        </View>
      ))}
      <Muted>{t.worktrees.hint}</Muted>
    </Card>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  item: {
    gap: space.xs,
    paddingVertical: space.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  badge: {
    fontSize: font.small,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  ready: { color: colors.textDim, backgroundColor: colors.accentDim },
  notReady: { color: colors.danger, borderWidth: 1, borderColor: colors.danger },
  path: { color: colors.textDim, fontSize: font.small },
  gap: { color: colors.textDim, fontSize: font.small },
  failed: { color: colors.danger },
});
