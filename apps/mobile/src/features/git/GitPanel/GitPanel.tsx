import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { ProjectGitInfo } from '@agentdeck/contracts';
import { Button, Card, Field, Loading, Mono, Muted, Row, Title } from '../../../shared/ui';
import { space } from '../../../shared/config/theme';
import { useT } from '../../../shared/config/i18n';
import { useProjectGit } from '../../../entities/project/useProjectGit';
import { useGitAction } from '../../../entities/project/useGitAction';
import { serverField } from '../../../shared/api/serverField';
import { facts } from '../facts';
import { styles } from './GitPanel.styles';
import { ChangedFile } from './ChangedFile/ChangedFile';

/**
 * Пульт git выбранного проекта: где мы, что изменилось, и шесть операций, что
 * умеет сервер, — переключиться, завести ветку, закоммитить, притянуть,
 * отправить.
 *
 * Своей модели поверх git тут нет: вывод команды показывается как есть, включая
 * ошибку. Ребейза и удаления веток нет намеренно — цену ошибки в них панель
 * взять на себя не может, а с телефона тем более.
 */
export function GitPanel({ projectPath }: { projectPath: string }) {
  const t = useT();
  const git = useProjectGit(projectPath);
  const [message, setMessage] = useState('');
  const [branchName, setBranchName] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [output, setOutput] = useState('');
  const [failed, setFailed] = useState('');

  const commit = useGitAction('commit');
  const push = useGitAction('push');
  const pull = useGitAction('pull');
  const checkout = useGitAction('checkout');
  const branch = useGitAction('branch');
  const busy =
    commit.isPending || push.isPending || pull.isPending || checkout.isPending || branch.isPending;

  const run = (
    action: ReturnType<typeof useGitAction>,
    body: Record<string, unknown>,
    after?: () => void,
  ): void => {
    setOutput('');
    setFailed('');
    action.mutate(
      { path: projectPath, ...body },
      {
        onSuccess: (result) => {
          setOutput(serverField(result, 'output'));
          after?.();
        },
        onError: (error: Error) => setFailed(error.message),
      },
    );
  };

  if (git.isLoading) return <Loading />;

  const info: ProjectGitInfo | undefined = git.data;
  if (!info?.isRepo) return null;
  if (info.error) {
    return (
      <Card>
        <Title>{t.git.title}</Title>
        <Mono style={styles.failed}>{info.error}</Mono>
      </Card>
    );
  }

  const where = info.unborn
    ? t.git.noCommits
    : info.detached
      ? t.git.detached
      : (info.branch ?? '—');

  return (
    <Card>
      <Row gap={space.sm}>
        <Title style={styles.grow}>{t.git.title}</Title>
        <Mono>{where}</Mono>
      </Row>

      {/* Одной строкой через точку: четыре отдельных куска на узком экране
          слипались в «↑0 изменено: 42 origin», где не видно границ. */}
      <Mono>{facts(info, t).join(' · ')}</Mono>

      {info.changedFiles.length > 0 ? (
        <Pressable onPress={() => setExpanded((value) => !value)}>
          <Muted>{expanded ? t.git.hideFiles : t.git.showFiles}</Muted>
        </Pressable>
      ) : null}
      {expanded ? (
        <View style={styles.files}>
          {info.changedFiles.map((change) => (
            <ChangedFile
              key={`${change.status}-${change.path}`}
              change={change}
              staged={t.git.staged}
            />
          ))}
          {info.changedFilesTruncated ? <Muted>{t.git.truncated}</Muted> : null}
        </View>
      ) : null}

      <Field
        value={message}
        onChangeText={setMessage}
        placeholder={t.git.commitMessage}
        autoCapitalize="sentences"
      />
      <Row gap={space.sm}>
        <Button
          title={t.git.commit}
          onPress={() => run(commit, { message }, () => setMessage(''))}
          disabled={busy || info.dirtyCount === 0 || !message.trim()}
          busy={commit.isPending}
          style={styles.grow}
        />
        <Button
          title={t.git.pull}
          onPress={() => run(pull, {})}
          disabled={busy || !info.remote}
          busy={pull.isPending}
          style={styles.grow}
        />
        <Button
          title={t.git.push}
          tone="accent"
          onPress={() => run(push, {})}
          disabled={busy || !info.remote || info.unborn || info.detached}
          busy={push.isPending}
          style={styles.grow}
        />
      </Row>

      <Row gap={space.sm}>
        <Field
          value={branchName}
          onChangeText={setBranchName}
          placeholder={t.git.newBranch}
          style={styles.grow}
        />
        <Button
          title={t.git.create}
          onPress={() => run(branch, { name: branchName }, () => setBranchName(''))}
          disabled={busy || !branchName.trim()}
          busy={branch.isPending}
        />
      </Row>

      {info.branches.length > 1 ? (
        <Row gap={space.xs} style={styles.wrap}>
          {info.branches.map((name) => (
            <Pressable
              key={name}
              onPress={() => run(checkout, { branch: name })}
              disabled={busy || name === info.branch}
              style={[styles.chip, name === info.branch && styles.chipOn]}
            >
              <Text style={styles.chipText} numberOfLines={1}>
                {name}
              </Text>
            </Pressable>
          ))}
        </Row>
      ) : null}

      {output ? <Mono numberOfLines={8}>{output}</Mono> : null}
      {failed ? <Mono style={styles.failed}>{failed}</Mono> : null}
    </Card>
  );
}
