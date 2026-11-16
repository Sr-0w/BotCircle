import { useCallback, useEffect, useMemo, useState } from 'react';
import { ACTIVE_TASK_STATUSES, type ArtifactDTO, type TaskDTO } from '@opendots/shared';
import { api } from '@/lib/api';
import { useServerEvent, useStore } from '@/lib/store';
import { t } from '@/lib/i18n';
import { FileCard, TaskCard } from '../chat/attachments';

type Scope = { agentId?: string; conversationId?: string };

function Empty({ title, text }: { title: string; text: string }) {
  return <div className="rounded-xl border border-dashed p-4 text-center"><p className="font-medium text-sm">{title}</p><p className="mt-1 text-muted-foreground text-xs">{text}</p></div>;
}

/** Tâches d'un Circle ou d'un chat : celles en cours d'abord, puis l'historique. Chaque carte se met à jour sur place. */
export function TasksList({ scope }: { scope: Scope }) {
  const [loaded, setLoaded] = useState<TaskDTO[] | null>(null);
  const reload = useCallback(() => { api.tasks(scope).then(setLoaded).catch(() => setLoaded([])); }, [scope.agentId, scope.conversationId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(reload, [reload]);
  // Une tâche créée ailleurs (par le compagnon, dans un autre onglet) apparaît sans recharger.
  const live = useStore((s) => s.tasks);
  const tasks = useMemo(() => {
    const mine = (task: TaskDTO) => (!scope.agentId || task.agentId === scope.agentId) && (!scope.conversationId || task.conversationId === scope.conversationId);
    const byId = new Map<string, TaskDTO>();
    for (const task of loaded ?? []) byId.set(task.id, task);
    for (const task of live) if (mine(task)) byId.set(task.id, task);
    return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [loaded, live, scope.agentId, scope.conversationId]);
  if (!loaded) return null;
  const active = tasks.filter((task) => ACTIVE_TASK_STATUSES.includes(task.status));
  const past = tasks.filter((task) => !ACTIVE_TASK_STATUSES.includes(task.status));
  if (!tasks.length) return <Empty title={t('Aucune tâche')} text={t('Les travaux longs confiés en arrière-plan apparaissent ici, avec leur état réel.')} />;
  return (
    <div className="space-y-4" data-tasks-list>
      {active.length > 0 && <section className="space-y-2"><h3 className="font-medium text-[11px] text-muted-foreground uppercase tracking-wider">{t('En cours')}</h3>{active.map((task) => <TaskCard key={task.id} taskId={task.id} compact showAgent={!scope.agentId} />)}</section>}
      {past.length > 0 && <section className="space-y-2"><h3 className="font-medium text-[11px] text-muted-foreground uppercase tracking-wider">{t('Terminées')}</h3>{past.map((task) => <TaskCard key={task.id} taskId={task.id} compact showAgent={!scope.agentId} />)}</section>}
    </div>
  );
}

/** Fichiers accessibles à un compagnon, ou échangés dans un chat. « Accès » montre qui l'a transmis à qui. */
export function FilesList({ scope }: { scope: Scope }) {
  const [files, setFiles] = useState<ArtifactDTO[] | null>(null);
  const reload = useCallback(() => { api.artifacts(scope).then(setFiles).catch(() => setFiles([])); }, [scope.agentId, scope.conversationId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(reload, [reload]);
  useServerEvent((e) => (e.type === 'artifact.changed' || e.type === 'task.changed' || e.type === 'turn.finished' || e.type === 'chat.changed') && reload(), [reload]);
  if (!files) return null;
  if (!files.length) return <Empty title={t('Aucun fichier')} text={t('Les fichiers que tu joins et ceux que les Circles produisent apparaissent ici.')} />;
  return <div className="space-y-2" data-files-list>{files.map((file) => <FileCard key={file.id} file={{ url: file.url, filename: file.name, mediaType: file.mediaType, size: file.size, artifactId: file.id }} />)}</div>;
}
