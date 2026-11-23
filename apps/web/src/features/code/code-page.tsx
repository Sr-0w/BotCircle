import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ACTIVE_TASK_STATUSES, type OpencodeInstanceDTO, type TaskDTO } from '@opendots/shared';
import { CheckIcon, EllipsisIcon, LoaderIcon, PencilIcon, PlusIcon, SearchIcon, ServerIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { OpencodeLogo } from '@/components/brand/opencode-logo';
import { api } from '@/lib/api';
import { useServerEvent, useStore } from '@/lib/store';
import { t } from '@/lib/i18n';
import { cn, relativeTime } from '@/lib/utils';
import { CODE_STATUS } from '../chat/attachments';
import { RenameTitle } from './rename-title';

import type { CodeFilter as Filter } from './code-live';

type MachineSessions = Awaited<ReturnType<typeof api.codeSessions>>[number];

const folder = (dir?: string | null) => dir?.replace(/\/+$/, '').split('/').pop() || null;

function dayGroup(iso: string, now = new Date()): 0 | 1 | 2 {
  const d = new Date(iso);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= start) return 0;
  if (d.getTime() >= start - 86_400_000) return 1;
  return 2;
}
const GROUPS = ['Aujourd’hui', 'Hier', 'Plus tôt'] as const;

/**
 * #72: Code, a first-class Web destination (the Android Code tab's twin). One canonical list of coding sessions —
 * started by you, delegated by a Circle, or found on a connected OpenCode machine — and a new session started right
 * here, without a Circle or a task. A row opens the exact session (route `#/code/<taskId>`).
 */
export function CodePage({ onOpen, filter, onFilter }: { onOpen: (taskId: string) => void; filter: Filter; onFilter: (f: Filter) => void }) {
  const tasks = useStore((s) => s.tasks), agents = useStore((s) => s.agents);
  const [instances, setInstances] = useState<OpencodeInstanceDTO[] | null>(null);
  const [machines, setMachines] = useState<MachineSessions[] | null>(null);
  const [instanceId, setInstanceId] = useState(''), [projects, setProjects] = useState<string[]>([]), [directory, setDirectory] = useState('');
  const [starting, setStarting] = useState(false), [query, setQuery] = useState('');

  const reloadInstances = useCallback(() => { api.opencodeInstances().then(setInstances).catch(() => setInstances([])); }, []);
  const reloadMachines = useCallback(() => { api.codeSessions().then(setMachines).catch(() => setMachines([])); }, []);
  useEffect(reloadInstances, [reloadInstances]);
  // Sessions started in OpenCode itself: re-listed when the tasks change (an attach links one) or a machine changes.
  useEffect(reloadMachines, [reloadMachines, tasks.length]);
  useServerEvent((e) => { if (e.type === 'opencode.changed') { reloadInstances(); reloadMachines(); } }, [reloadInstances, reloadMachines]);

  useEffect(() => { if (!instanceId && instances?.length) setInstanceId((instances.find((i) => i.state === 'online') ?? instances[0]).id); }, [instances, instanceId]);
  const instance = instances?.find((i) => i.id === instanceId);
  useEffect(() => {
    if (!instanceId) return;
    api.opencodeProjects(instanceId).then((list) => {
      const dirs = [...new Set([instance?.defaultDirectory, ...list.map((p) => p.worktree)].filter((d): d is string => !!d))];
      // The project of the last session on this machine first: ＋ goes straight back to where you work.
      const recent = tasks.filter((x) => x.provider === 'opencode' && x.external?.instanceId === instanceId && x.external?.directory).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.external?.directory ?? '';
      setProjects(dirs); setDirectory((d) => (dirs.includes(d) ? d : dirs.includes(recent) ? recent : dirs[0] ?? ''));
    }).catch(() => setProjects([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, instance?.defaultDirectory]);

  const circleName = (task: TaskDTO) => agents.find((a) => a.id === task.agentId)?.name ?? t('un Circle');
  const origin = (task: TaskDTO) => task.requestedBy === 'user' ? t('Par toi') : task.requestedBy === 'opencode' ? t('Depuis OpenCode') : task.requestedBy === 'agent' ? t('Par {v0}', { v0: circleName(task) }) : t('Depuis un chat');
  const q = query.trim().toLowerCase();
  const matches = (...parts: (string | null | undefined)[]) => !q || parts.filter(Boolean).join(' ').toLowerCase().includes(q);

  // One logical session = one row: tasks are canonical; an OpenCode session already linked to a task is not repeated.
  const sessions = useMemo(() => tasks
    .filter((task) => task.provider === 'opencode')
    // Same taxonomy as Android's Code tab (CodeSessions.kt): Mine = started by you, Circles = delegated by a Circle.
    .filter((task) => filter === 'all' || (filter === 'mine' ? task.requestedBy === 'user' : task.requestedBy === 'agent'))
    .filter((task) => matches(task.title, task.external?.instanceName, task.external?.directory, origin(task)))
    .sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [tasks, filter, q, agents]);
  const linked = useMemo(() => new Set(tasks.filter((x) => x.external?.sessionId).map((x) => `${x.external!.instanceId}:${x.external!.sessionId}`)), [tasks]);
  const outside = filter !== 'all' ? [] : (machines ?? []).flatMap((m) => m.sessions
    .filter((s) => !s.taskId && !linked.has(`${m.instanceId}:${s.id}`) && matches(s.title, m.instanceName, s.directory))
    .map((s) => ({ machine: m, session: s })));
  const groups = useMemo(() => {
    const out: TaskDTO[][] = [[], [], []];
    for (const task of sessions) out[dayGroup(task.startedAt ?? task.createdAt)].push(task);
    return out;
  }, [sessions]);
  const unreachable = (machines ?? []).filter((m) => !m.reachable);

  async function start() {
    if (!instanceId) return;
    setStarting(true);
    // ＋ opens the session itself: the first message is written there, with its model picker (as on Android).
    try { const task = await api.startCodeSession({ instanceId, directory: directory || null, instruction: '' }); onOpen(task.id); }
    catch (e) { toast.error((e as Error).message); } finally { setStarting(false); }
  }
  async function attach(machine: MachineSessions, session: MachineSessions['sessions'][number]) {
    try { const task = await api.attachCodeSession({ instanceId: machine.instanceId, sessionId: session.id, directory: session.directory || null }); onOpen(task.id); }
    catch (e) { toast.error((e as Error).message); }
  }

  const loading = instances === null;
  const empty = !loading && sessions.length === 0 && outside.length === 0;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-code-page>
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex-1 font-semibold text-2xl tracking-tight">{t('Code')}</h1>
          {instances && instances.length > 0 && (
            <div className="flex flex-wrap items-center gap-2" data-new-code-session>
              <select aria-label={t('Machine')} className="h-8 rounded-md border bg-background px-2 text-xs" value={instanceId} onChange={(e) => setInstanceId(e.target.value)}>
                {instances.map((i) => <option key={i.id} value={i.id}>{i.name}{i.state === 'offline' ? ` · ${t('Injoignable')}` : ''}</option>)}
              </select>
              <select aria-label={t('Projet')} className="h-8 max-w-44 rounded-md border bg-background px-2 text-xs" value={directory} onChange={(e) => setDirectory(e.target.value)}>
                {!projects.length && <option value="">{t('Le dossier par défaut de la machine')}</option>}
                {projects.map((d) => <option key={d} value={d}>{folder(d) ?? d}</option>)}
              </select>
              <Button size="sm" disabled={starting || !instanceId || instance?.state === 'offline'} onClick={() => void start()} data-code-new>
                {starting ? <LoaderIcon className="animate-spin" /> : <PlusIcon />}{t('Nouvelle session')}
              </Button>
            </div>
          )}
        </div>

        {instances && instances.length === 0 && (
          <div className="space-y-3 rounded-2xl border border-dashed p-6 text-center" data-code-no-machine>
            <ServerIcon className="mx-auto size-6 text-muted-foreground" />
            <p className="font-medium text-sm">{t('Aucune machine connectée')}</p>
            <p className="text-muted-foreground text-sm">{t('Connecte une machine de développement où tourne OpenCode : tu pourras y lancer des sessions ici, et tes Circles y déléguer du code.')}</p>
            <Button size="sm" variant="secondary" onClick={() => (window.location.hash = '#/settings/opencode')}>{t('Connecter une machine')}</Button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <div role="radiogroup" aria-label={t('Filtrer les sessions')} className="flex gap-1" data-code-filters>
            {([['all', 'Toutes'], ['mine', 'Les miennes'], ['circles', 'Circles']] as const).map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={filter === value} onClick={() => onFilter(value)} data-code-filter={value}
                className={cn('rounded-full border px-3 py-1 text-xs transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring', filter === value ? 'border-foreground/20 bg-accent text-foreground' : 'text-muted-foreground')}>{t(label)}</button>
            ))}
          </div>
          <div className="relative ml-auto w-full sm:w-56">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Chercher une session…')} aria-label={t('Chercher une session…')} className="h-8 w-full rounded-lg border bg-transparent pr-2 pl-8 text-xs outline-none focus:border-ring" />
          </div>
        </div>

        {unreachable.length > 0 && (
          <p className="text-muted-foreground text-xs" role="status" data-code-unreachable>
            {t('Injoignable : {v0}. Ses sessions OpenCode ne peuvent pas être listées pour l’instant.', { v0: unreachable.map((m) => m.instanceName).join(', ') })}
          </p>
        )}
        {loading && <LoaderIcon className="mx-auto animate-spin text-muted-foreground" />}
        {empty && instances!.length > 0 && (
          <div className="rounded-2xl border border-dashed p-6 text-center text-muted-foreground text-sm" data-code-empty>
            {q ? t('Aucune session ne correspond.') : t('Les sessions que tu lances, et celles que tes Circles lancent sur tes machines connectées, apparaissent ici.')}
          </div>
        )}

        {groups.map((list, index) => list.length > 0 && (
          <section key={index} aria-label={t(GROUPS[index])}>
            <h2 className="px-1 pb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">{t(GROUPS[index])}</h2>
            <div className="divide-y rounded-2xl border">
              {list.map((task) => <SessionRow key={task.id} task={task} origin={origin(task)} onOpen={() => onOpen(task.id)} />)}
            </div>
          </section>
        ))}

        {outside.length > 0 && (
          <section aria-label={t('Depuis OpenCode')}>
            <h2 className="px-1 pb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">{t('Depuis OpenCode')}</h2>
            <div className="divide-y rounded-2xl border">
              {outside.map(({ machine, session }) => (
                <button key={`${machine.instanceId}:${session.id}`} type="button" onClick={() => void attach(machine, session)} data-outside-session={session.id}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring">
                  <OpencodeLogo size={16} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{session.title || t('Session sans titre')}</span>
                    <span className="block truncate text-muted-foreground text-xs">{[t('Depuis OpenCode'), machine.instanceName, folder(session.directory), relativeTime(new Date(session.updatedAt).toISOString())].filter(Boolean).join(' · ')}</span>
                  </span>
                  {session.busy && <StatusPill running label={t('En cours')} />}
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function StatusPill({ label, running, tone }: { label: string; running?: boolean; tone?: 'danger' | 'muted' }) {
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5 text-xs', tone === 'danger' ? 'text-destructive' : 'text-muted-foreground')} data-code-status={label}>
      {running && <span className="relative flex size-1.5"><span className="absolute inline-flex size-full animate-ping rounded-full bg-success/60 motion-reduce:animate-none" /><span className="relative inline-flex size-1.5 rounded-full bg-success" /></span>}
      {label}
    </span>
  );
}

function SessionRow({ task, origin, onOpen }: { task: TaskDTO; origin: string; onOpen: () => void }) {
  const [editing, setEditing] = useState(false);
  const disconnected = Boolean(task.external?.unreachable) && ACTIVE_TASK_STATUSES.includes(task.status);
  const status = disconnected ? t('Déconnecté') : t(CODE_STATUS[task.status]);
  const changes = task.external?.changes;
  // #69: rename from the row (…, right click, long press); the session itself is never touched.
  return (
    <div className="flex items-center" data-code-row={task.id} onContextMenu={(e) => { e.preventDefault(); setEditing(true); }}>
      {editing ? (
        <div className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5"><OpencodeLogo size={16} /><RenameTitle taskId={task.id} value={task.title} onDone={() => setEditing(false)} /></div>
      ) : (
        <button type="button" onClick={onOpen} data-code-session={task.id} data-code-origin={task.requestedBy}
          aria-label={[task.title, origin, status].join(', ')}
          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring">
          <OpencodeLogo size={16} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{task.title}</span>
            <span className="block truncate text-muted-foreground text-xs">{[origin, task.external?.instanceName, folder(task.external?.directory), relativeTime(task.startedAt ?? task.createdAt)].filter(Boolean).join(' · ')}</span>
          </span>
          {changes && changes.files > 0 && (changes.additions > 0 || changes.deletions > 0) && (
            <span className="shrink-0 text-xs"><span className="text-success">+{changes.additions}</span> <span className="text-destructive">−{changes.deletions}</span></span>
          )}
          {task.status === 'completed' && !disconnected
            ? <span className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs" data-code-status={status}><CheckIcon className="size-3" />{status}</span>
            : <StatusPill label={status} running={task.status === 'running' && !disconnected} tone={task.status === 'failed' || task.status === 'waiting_for_user' || disconnected ? 'danger' : 'muted'} />}
        </button>
      )}
      {!editing && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="icon-xs" variant="ghost" className="mr-2 shrink-0 text-muted-foreground/70 hover:text-foreground" aria-label={t('Actions de la session')} data-code-row-menu><EllipsisIcon /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setEditing(true)} data-code-rename-item><PencilIcon />{t('Renommer')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}