import { useCallback, useEffect, useState } from 'react';
import { LoaderIcon } from 'lucide-react';
import { ACTIVE_TASK_STATUSES, type ArtifactAccessDTO, type ArtifactDTO, type ArtifactGrantDTO, type TaskEventDTO } from '@opendots/shared';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useServerEvent, useStore } from '@/lib/store';
import { formatDateTime } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { DotAvatar } from '../dot-avatar';
import { FileCard, fileKind, TASK_STATUS_LABELS, taskAction, TaskStatusIcon, useTask } from '../chat/attachments';
import { formatBytes } from '../chat/composer';

/** « Détails » d'une tâche : consigne, état observé, journal des étapes, fichiers produits et consigne à transmettre. */
export function TaskDialog({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const task = useTask(taskId);
  const agent = useStore((s) => s.agents.find((a) => a.id === task?.agentId));
  const [events, setEvents] = useState<TaskEventDTO[] | null>(null);
  const [instruction, setInstruction] = useState('');
  const reload = useCallback(() => { api.task(taskId).then((result) => setEvents(result.events)).catch(() => setEvents([])); }, [taskId]);
  useEffect(reload, [reload]);
  useServerEvent((e) => e.type === 'task.changed' && e.task.id === taskId && reload(), [reload, taskId]);
  const active = task ? ACTIVE_TASK_STATUSES.includes(task.status) : false;
  async function send() {
    const text = instruction.trim();
    if (!text) return;
    try { await api.taskInstruction(taskId, text); setInstruction(''); toast.success(t('Consigne transmise')); } catch (error) { toast.error((error as Error).message); }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[88vh] max-w-xl flex-col gap-0 p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2">{task && <TaskStatusIcon status={task.status} />}<span className="min-w-0 truncate">{task?.title ?? t('Tâche')}</span></DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-1.5">
            {agent && <><DotAvatar color={agent.color} shape={agent?.avatar} size={14} /> {agent.name} ·</>}
            {task && <>{t(TASK_STATUS_LABELS[task.status])}{task.completedSteps > 0 && ` · ${t('{count} actions', { count: task.completedSteps })}`} · {formatDateTime(task.createdAt)}</>}
          </DialogDescription>
        </DialogHeader>
        {!task ? <LoaderIcon className="m-8 mx-auto animate-spin" /> : (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-sm">
            <section><h3 className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wider">{t('Consigne')}</h3><p className="whitespace-pre-wrap">{task.instruction}</p></section>
            {(task.usedModel || task.model) && <section data-task-model-details><h3 className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wider">{t('Modèle')}</h3><p>{task.usedModel ?? `${task.model!.provider}:${task.model!.model}`}{task.model ? ` · ${t('demandé pour cette tâche')}` : ` · ${t('modèle du Circle')}`}</p></section>}
            {(task.blocker || task.error) && <section className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs"><p className="font-medium">{task.error ? t('Échec') : t('Blocage')}</p><p className="text-muted-foreground">{task.error ?? task.blocker}</p></section>}
            {task.result && <section><h3 className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wider">{t('Résultat')}</h3><p className="whitespace-pre-wrap">{task.result}</p></section>}
            {task.artifacts.length > 0 && <section className="space-y-2"><h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wider">{t('Fichiers produits')}</h3>{task.artifacts.map((artifact) => <FileCard key={artifact.id} file={{ url: artifact.url, filename: artifact.name, mediaType: artifact.mediaType, size: artifact.size, artifactId: artifact.id }} />)}</section>}
            <section>
              <h3 className="mb-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wider">{t('Journal')}</h3>
              {!events ? <LoaderIcon className="size-4 animate-spin" /> : events.length === 0 ? <p className="text-muted-foreground text-xs">{t('Aucune étape pour l’instant.')}</p> : (
                <ol className="space-y-1.5" data-task-events>{events.map((event) => (
                  <li key={event.seq} className="flex gap-2 text-xs">
                    <span className="w-28 shrink-0 text-muted-foreground tabular-nums">{formatDateTime(event.createdAt)}</span>
                    <span className={event.kind === 'error' ? 'flex-1 text-destructive' : event.kind === 'step' ? 'flex-1' : 'flex-1 text-muted-foreground'}>{event.kind === 'instruction' ? `${t('Consigne')} : ${event.summary}` : event.summary}</span>
                  </li>
                ))}</ol>
              )}
            </section>
          </div>
        )}
        {task && active && (
          <div className="space-y-2 border-t px-5 py-3">
            <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void send(); }}>
              <Input value={instruction} onChange={(event) => setInstruction(event.target.value)} maxLength={2000} placeholder={t('Préciser ou réorienter la tâche…')} aria-label={t('Consigne pour la tâche')} />
              <Button type="submit" disabled={!instruction.trim()}>{t('Envoyer')}</Button>
            </form>
            <div className="flex gap-1.5">
              {(task.status === 'running' || task.status === 'queued') && <Button size="sm" variant="secondary" onClick={() => void taskAction(task, 'pause')}>{t('Pause')}</Button>}
              {(task.status === 'paused' || task.status === 'waiting_for_user') && <Button size="sm" variant="secondary" onClick={() => void taskAction(task, 'resume')}>{t('Reprendre')}</Button>}
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void taskAction(task, 'cancel')}>{t('Annuler la tâche')}</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const ACCESS_LABELS: Record<string, string> = { create: 'Créé', read: 'Lu', download: 'Téléchargé', share: 'Partagé', revoke: 'Accès retiré', publish: 'Remis dans la conversation', delete: 'Supprimé', denied: 'Accès refusé' };

/** Qui a accès à un fichier, qui l'a transmis à qui, et ce qui en a été fait. L'accès se retire ou s'accorde ici. */
export function ArtifactDialog({ artifactId, onClose }: { artifactId: string; onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const [data, setData] = useState<(ArtifactDTO & { grants: ArtifactGrantDTO[]; access: ArtifactAccessDTO[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => { api.artifact(artifactId).then(setData).catch((e) => setError(e.message)); }, [artifactId]);
  useEffect(reload, [reload]);
  useServerEvent((e) => e.type === 'artifact.changed' && e.artifactId === artifactId && reload(), [reload, artifactId]);
  const who = (actor: string | null) => !actor || actor === 'user' ? t('Toi') : agents.find((a) => a.id === actor)?.name ?? (actor.startsWith('task_') ? t('Un worker') : t('Un Circle'));
  const detail = (entry: ArtifactAccessDTO) => entry.action === 'share' || entry.action === 'revoke' ? agents.reduce((text, agent) => text.replaceAll(agent.id, agent.name), entry.detail ?? '') : '';
  const activeGrants = data?.grants.filter((grant) => !grant.revokedAt) ?? [];
  const others = agents.filter((agent) => !activeGrants.some((grant) => grant.agentId === agent.id));
  const apply = (run: Promise<{ grants: ArtifactGrantDTO[]; access: ArtifactAccessDTO[] }>) => run.then((history) => setData((current) => current && { ...current, ...history })).catch((e) => toast.error(e.message));
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[88vh] max-w-lg flex-col gap-0 p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="truncate">{data?.name ?? t('Fichier')}</DialogTitle>
          <DialogDescription>{data ? `${fileKind(data.mediaType, data.name)} · ${formatBytes(data.size)} · ${t('ajouté par {v0}', { v0: who(data.authorKind === 'user' ? 'user' : data.authorId) })} · ${formatDateTime(data.createdAt)}` : ' '}</DialogDescription>
        </DialogHeader>
        {error ? <p className="p-5 text-destructive text-sm">{error}</p> : !data ? <LoaderIcon className="m-8 mx-auto animate-spin" /> : (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-sm">
            <section className="space-y-1.5">
              <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wider">{t('Circles qui y ont accès')}</h3>
              {activeGrants.length === 0 && <p className="text-muted-foreground text-xs">{t('Aucun Circle ne peut lire ce fichier.')}</p>}
              {activeGrants.map((grant) => { const agent = agents.find((a) => a.id === grant.agentId); return (
                <div key={grant.agentId} className="flex items-center gap-2" data-grant>
                  {agent && <DotAvatar color={agent.color} shape={agent?.avatar} size={16} />}
                  <span className="min-w-0 flex-1"><span className="font-medium">{agent?.name ?? t('Un Circle')}</span> <span className="text-muted-foreground text-xs">· {t('par {v0}', { v0: who(grant.grantedBy) })} · {formatDateTime(grant.createdAt)}</span></span>
                  <Button size="sm" variant="ghost" className="h-7 text-destructive text-xs" onClick={() => void apply(api.revokeArtifact(artifactId, grant.agentId))}>{t('Retirer')}</Button>
                </div>
              ); })}
              {others.length > 0 && <div className="flex flex-wrap gap-1.5 pt-1">{others.map((agent) => <Button key={agent.id} size="sm" variant="secondary" className="h-7 rounded-full text-xs" onClick={() => void apply(api.grantArtifact(artifactId, agent.id))}><DotAvatar color={agent.color} shape={agent?.avatar} size={12} /> {t('Donner à {v0}', { v0: agent.name })}</Button>)}</div>}
            </section>
            <section>
              <h3 className="mb-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wider">{t('Historique')}</h3>
              <ol className="space-y-1.5" data-artifact-history>{data.access.map((entry, index) => (
                <li key={index} className="flex gap-2 text-xs">
                  <span className="w-28 shrink-0 text-muted-foreground tabular-nums">{formatDateTime(entry.createdAt)}</span>
                  <span className="flex-1"><span className="font-medium">{who(entry.actor)}</span> — {t(ACCESS_LABELS[entry.action] ?? entry.action)} {detail(entry)}</span>
                </li>
              ))}</ol>
            </section>
            <div className="flex gap-1.5">
              <Button asChild size="sm" variant="secondary"><a href={`${data.url}?download=1`} download={data.name}>{t('Télécharger')}</a></Button>
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => { if (confirm(t('Supprimer définitivement « {v0} » ?', { v0: data.name }))) void api.deleteArtifact(artifactId).then(onClose).catch((e) => toast.error(e.message)); }}>{t('Supprimer le fichier')}</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
