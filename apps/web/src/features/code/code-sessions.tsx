import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { OpencodeInstanceDTO, TaskDTO } from '@opendots/shared';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { openCodeWorkspace } from '@/lib/work-store';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/utils';
import { OpencodeLogo } from '@/components/brand/opencode-logo';

type MachineSessions = Awaited<ReturnType<typeof api.codeSessions>>[number];

/**
 * Code (#31, #47) on the web: every coding session in one list — started by you, by a Circle, or in OpenCode
 * itself — and a new session started directly on a connected machine, in one of its projects.
 */
export function CodeSessions({ instances }: { instances: OpencodeInstanceDTO[] }) {
  const tasks = useStore((s) => s.tasks), agents = useStore((s) => s.agents);
  const [machines, setMachines] = useState<MachineSessions[]>([]);
  const [instanceId, setInstanceId] = useState<string>(''), [projects, setProjects] = useState<string[]>([]), [directory, setDirectory] = useState('');
  const [instruction, setInstruction] = useState(''), [starting, setStarting] = useState(false);
  useEffect(() => { api.codeSessions().then(setMachines).catch(() => {}); }, [tasks.length]);
  useEffect(() => { if (!instanceId && instances.length) setInstanceId((instances.find((i) => i.state === 'online') ?? instances[0]).id); }, [instances, instanceId]);
  const instance = instances.find((i) => i.id === instanceId);
  useEffect(() => {
    if (!instanceId) return;
    api.opencodeProjects(instanceId).then((list) => {
      const dirs = [...new Set([instance?.defaultDirectory, ...list.map((p) => p.worktree)].filter((d): d is string => !!d))];
      setProjects(dirs); setDirectory((d) => (dirs.includes(d) ? d : dirs[0] ?? ''));
    }).catch(() => { setProjects([]); });
  }, [instanceId, instance?.defaultDirectory]);
  const sessions = useMemo(() => tasks.filter((task) => task.provider === 'opencode').sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [tasks]);
  const outside = machines.flatMap((m) => m.sessions.filter((s) => !s.taskId).map((s) => ({ machine: m, session: s })));
  const by = (task: TaskDTO) => task.requestedBy === 'user' ? t('Par toi') : task.requestedBy === 'opencode' ? t('Depuis OpenCode') : t('Par {v0}', { v0: agents.find((a) => a.id === task.agentId)?.name ?? t('un Circle') });

  async function start() {
    if (!instanceId || !instruction.trim()) return;
    setStarting(true);
    try { const task = await api.startCodeSession({ instanceId, directory: directory || null, instruction: instruction.trim() }); setInstruction(''); openCodeWorkspace(task.id); }
    catch (e) { toast.error((e as Error).message); } finally { setStarting(false); }
  }
  return (
    <section className="space-y-4" data-code-sessions>
      {instances.length > 0 && (
        <div className="space-y-2 rounded-2xl border p-4" data-new-code-session>
          <p className="font-medium text-sm">{t('Nouvelle session de code')}</p>
          <div className="flex flex-wrap gap-2">
            <select aria-label={t('Machine')} className="h-8 rounded-md border bg-background px-2 text-xs" value={instanceId} onChange={(e) => setInstanceId(e.target.value)}>
              {instances.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
            <select aria-label={t('Projet')} className="h-8 min-w-32 flex-1 rounded-md border bg-background px-2 text-xs" value={directory} onChange={(e) => setDirectory(e.target.value)}>
              {!projects.length && <option value="">{t('Le dossier par défaut de la machine')}</option>}
              {projects.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <Textarea rows={3} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder={t('Que doit faire OpenCode ?')} aria-label={t('Consigne')} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-48 flex-1 text-muted-foreground text-xs">{t('Utilise le modèle par défaut de la session ; tu peux le changer dans la session.')}</p>
            <Button size="sm" disabled={starting || !instruction.trim()} onClick={() => void start()}>{t('Créer et lancer')}</Button>
          </div>
        </div>
      )}
      {(sessions.length > 0 || outside.length > 0) && (
        <div className="divide-y rounded-2xl border">
          {sessions.map((task) => (
            <button key={task.id} type="button" onClick={() => openCodeWorkspace(task.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/40" data-code-session={task.id}>
              <OpencodeLogo size={16} />
              <span className="min-w-0 flex-1"><span className="block truncate text-sm">{task.title}</span><span className="block truncate text-muted-foreground text-xs">{[by(task), task.external?.directory?.replace(/\/+$/, '').split('/').pop(), formatDateTime(task.createdAt)].filter(Boolean).join(' · ')}</span></span>
              {task.external?.changes && task.external.changes.files > 0 && <span className="shrink-0 text-xs"><span className="text-emerald-500">+{task.external.changes.additions}</span> <span className="text-destructive">−{task.external.changes.deletions}</span></span>}
            </button>
          ))}
          {outside.map(({ machine, session }) => (
            <button key={`${machine.instanceId}:${session.id}`} type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/40" data-outside-session={session.id}
              onClick={() => api.attachCodeSession({ instanceId: machine.instanceId, sessionId: session.id, directory: session.directory || null }).then((task) => openCodeWorkspace(task.id)).catch((e) => toast.error(e.message))}>
              <OpencodeLogo size={16} />
              <span className="min-w-0 flex-1"><span className="block truncate text-sm">{session.title || t('Session sans titre')}</span><span className="block truncate text-muted-foreground text-xs">{[t('Depuis OpenCode'), machine.instanceName, session.directory.replace(/\/+$/, '').split('/').pop()].filter(Boolean).join(' · ')}</span></span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
