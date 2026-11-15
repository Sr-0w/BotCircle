import { useCallback, useEffect, useState } from 'react';
import { LoaderIcon, PlusIcon, RefreshCwIcon, TerminalSquareIcon, Trash2Icon } from 'lucide-react';
import type { OpencodeInstanceDTO } from '@opendots/shared';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { useServerEvent } from '@/lib/store';
import { relativeTime } from '@/lib/utils';
import { t } from '@/lib/i18n';

const STATES = { online: 'En ligne', offline: 'Injoignable', unknown: 'Jamais contrôlée' } as const;
type Draft = { id?: string; name: string; baseUrl: string; username: string; password: string; defaultDirectory: string };
const EMPTY: Draft = { name: '', baseUrl: '', username: 'opencode', password: '', defaultDirectory: '' };

/**
 * Les instances OpenCode du compte : des machines de développement où tourne `opencode serve`. BotCircle s'y connecte
 * par l'API d'OpenCode ; l'adresse et le mot de passe se saisissent ici, jamais dans une conversation.
 */
export function OpencodePage() {
  const [instances, setInstances] = useState<OpencodeInstanceDTO[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null), [busy, setBusy] = useState(false), [checking, setChecking] = useState<string | null>(null);
  const reload = useCallback(() => { api.opencodeInstances().then(setInstances).catch((e) => toast.error(e.message)); }, []);
  useEffect(reload, [reload]);
  useServerEvent((e) => e.type === 'opencode.changed' && reload(), [reload]);
  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      // Mot de passe vide à la modification : inchangé.
      const saved = await api.saveOpencodeInstance({ id: draft.id, name: draft.name, baseUrl: draft.baseUrl, username: draft.username || 'opencode', defaultDirectory: draft.defaultDirectory || null, ...(draft.password ? { password: draft.password } : draft.id ? {} : { password: null }) });
      setDraft(null); reload();
      if (saved.state === 'online') toast.success(t('Instance connectée · OpenCode {v0}', { v0: saved.version ?? '' })); else toast.error(saved.lastError ?? t('Instance injoignable.'));
    } catch (error) { toast.error((error as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 p-5 sm:p-8">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><TerminalSquareIcon className="size-5" />OpenCode</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('Connecte une machine de développement : tes compagnons autorisés pourront y déléguer du code à OpenCode, et tu suivras la session en direct.')}</p>
        </div>
        {!instances ? <LoaderIcon className="animate-spin" /> : instances.length === 0 && !draft ? <div className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t('Aucune instance connectée.')}</div> : null}
        {instances?.map((instance) => (
          <section key={instance.id} className="space-y-2 rounded-2xl border bg-card p-4" aria-label={instance.name} data-instance-state={instance.state}>
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="font-medium">{instance.name}</h2>
                <p className="truncate font-mono text-muted-foreground text-xs">{instance.baseUrl}{instance.defaultDirectory && ` · ${instance.defaultDirectory}`}</p>
              </div>
              <span className={'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ' + (instance.state === 'offline' ? 'text-destructive' : instance.state === 'online' ? '' : 'text-muted-foreground')}>
                <span className={'size-1.5 rounded-full ' + (instance.state === 'online' ? 'bg-success' : instance.state === 'offline' ? 'bg-destructive' : 'bg-muted-foreground/50')} />{t(STATES[instance.state])}
              </span>
            </div>
            <p className="text-muted-foreground text-xs">
              {instance.state === 'offline' ? instance.lastError : [instance.version && `OpenCode ${instance.version}`, instance.lastSeenAt && t('vue {when}', { when: relativeTime(instance.lastSeenAt) }), instance.activeTasks > 0 && t('{count} tâche(s) en cours', { count: instance.activeTasks }), instance.hasPassword ? t('protégée par mot de passe') : t('sans mot de passe')].filter(Boolean).join(' · ')}
            </p>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="secondary" className="h-7 rounded-full text-xs" disabled={checking === instance.id} onClick={() => { setChecking(instance.id); void api.checkOpencodeInstance(instance.id).then(reload).catch((e) => toast.error(e.message)).finally(() => setChecking(null)); }}><RefreshCwIcon className={checking === instance.id ? 'animate-spin' : ''} /> {t('Contrôler')}</Button>
              <Button size="sm" variant="ghost" className="h-7 rounded-full text-xs" onClick={() => setDraft({ id: instance.id, name: instance.name, baseUrl: instance.baseUrl, username: instance.username, password: '', defaultDirectory: instance.defaultDirectory ?? '' })}>{t('Modifier')}</Button>
              <Button size="sm" variant="ghost" className="h-7 rounded-full text-destructive text-xs" onClick={() => { if (confirm(t('Retirer « {v0} » ? Les tâches et échanges passés restent consultables.', { v0: instance.name }))) void api.deleteOpencodeInstance(instance.id).then(reload).catch((e) => toast.error(e.message)); }}><Trash2Icon /> {t('Retirer')}</Button>
            </div>
          </section>
        ))}
        {draft ? (
          <form className="space-y-3 rounded-2xl border bg-card p-4" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-label={t('Instance OpenCode')}>
            <h2 className="font-medium">{draft.id ? t('Modifier l’instance') : t('Nouvelle instance')}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5"><Label htmlFor="oc-name" className="text-xs">{t('Nom')}</Label><Input id="oc-name" value={draft.name} maxLength={60} placeholder={t('PC de dev')} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
              <div className="space-y-1.5"><Label htmlFor="oc-url" className="text-xs">{t('Adresse de l’API')}</Label><Input id="oc-url" value={draft.baseUrl} placeholder="https://code.exemple.fr" className="font-mono" onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} /></div>
              <div className="space-y-1.5"><Label htmlFor="oc-user" className="text-xs">{t('Utilisateur')}</Label><Input id="oc-user" value={draft.username} autoComplete="off" onChange={(e) => setDraft({ ...draft, username: e.target.value })} /></div>
              <div className="space-y-1.5"><Label htmlFor="oc-pass" className="text-xs">{t('Mot de passe')}</Label><Input id="oc-pass" type="password" value={draft.password} autoComplete="new-password" placeholder={draft.id ? t('inchangé') : 'OPENCODE_SERVER_PASSWORD'} onChange={(e) => setDraft({ ...draft, password: e.target.value })} /></div>
              <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="oc-dir" className="text-xs">{t('Dossier du projet par défaut')}</Label><Input id="oc-dir" value={draft.defaultDirectory} placeholder="/home/moi/projets/mon-app" className="font-mono" onChange={(e) => setDraft({ ...draft, defaultDirectory: e.target.value })} /></div>
            </div>
            <div className="flex gap-2"><Button type="submit" disabled={busy || !draft.name.trim() || !draft.baseUrl.trim()}>{busy && <LoaderIcon className="animate-spin" />}{t('Enregistrer et contrôler')}</Button><Button type="button" variant="ghost" onClick={() => setDraft(null)}>{t('Annuler')}</Button></div>
          </form>
        ) : <Button variant="secondary" onClick={() => setDraft(EMPTY)}><PlusIcon /> {t('Ajouter une instance')}</Button>}
        <details className="rounded-2xl border p-4 text-sm">
          <summary className="cursor-pointer font-medium">{t('Comment exposer OpenCode à BotCircle')}</summary>
          <div className="mt-2 space-y-2 text-muted-foreground text-xs">
            <p>{t('Sur la machine de développement, lance OpenCode en serveur, protégé par un mot de passe :')}</p>
            <pre className="overflow-x-auto rounded-lg bg-muted p-2 font-mono">OPENCODE_SERVER_PASSWORD=… opencode serve --hostname 0.0.0.0 --port 4096</pre>
            <p>{t('Le serveur BotCircle doit pouvoir joindre cette adresse. OpenCode ne traverse pas seul un NAT : utilise un réseau privé (Tailscale, WireGuard), un tunnel SSH ou un reverse proxy HTTPS. N’expose jamais ce port sans mot de passe.')}</p>
            <p>{t('Ensuite, autorise un compagnon dans son profil : « Déléguer du code à OpenCode ».')}</p>
          </div>
        </details>
      </div>
    </div>
  );
}
