import { Text, View } from 'react-native';
import { Card, Loading, Mono, Muted, Row, Title } from '../../../shared/ui';
import { space } from '../../../shared/config/theme';
import { useT } from '../../../shared/config/i18n';
import { visibleCopies } from '../copy-facts';
import { useProjectWorktrees } from '../../../entities/project/useProjectWorktrees';
import { copyFacts } from '../copyFacts';
import { serverField } from '../../../shared/api/serverField';
import { styles } from './Worktrees.styles';

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
