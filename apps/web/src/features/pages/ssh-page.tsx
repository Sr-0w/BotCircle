import { useCallback, useEffect, useState } from 'react';
import { LoaderIcon, PlusIcon, ServerIcon, ShieldAlertIcon, ShieldCheckIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api, type SshConnection } from '@/lib/api';
import { useStore } from '@/lib/store';
import { t } from '@/lib/i18n';
import { cn, formatDateTime } from '@/lib/utils';

type Draft = { id?: string; name: string; description: string; host: string; port: string; username: string; auth: 'key' | 'password'; privateKey: string; passphrase: string; password: string; agents: string[]; approval: 'ask' | 'auto' };
const empty: Draft = { name: '', description: '', host: '', port: '22', username: '', auth: 'key', privateKey: '', passphrase: '', password: '', agents: [], approval: 'ask' };

/**
 * #52: machines reachable over SSH. Secrets are entered here and never shown again; each machine lists the Circles
 * that may use it; the host key is checked and must be trusted before any command.
 */
export function SshPage() {
  const agents = useStore((s) => s.agents);
  const [rows, setRows] = useState<SshConnection[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null), [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null), [pending, setPending] = useState<{ id: string; hostKey: string } | null>(null);
  const reload = useCallback(() => { api.sshConnections().then(setRows).catch((e) => toast.error(e.message)); }, []);
  useEffect(reload, [reload]);
  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      const body = { name: draft.name, description: draft.description, host: draft.host, port: Number(draft.port) || 22, username: draft.username, auth: draft.auth, agents: draft.agents, approval: draft.approval,
        ...(draft.privateKey ? { privateKey: draft.privateKey } : {}), ...(draft.passphrase ? { passphrase: draft.passphrase } : {}), ...(draft.password ? { password: draft.password } : {}) };
      const saved = await api.saveSsh(draft.id ?? null, body);
      setDraft(null); reload(); void test(saved.id);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  async function test(id: string, trust = false) {
    setTesting(id);
    try {
      const r = await api.testSsh(id, trust);
      if (r.ok) { toast.success(t('Connexion réussie')); setPending(null); }
      else if (!r.trusted && r.hostKey) setPending({ id, hostKey: r.hostKey });
      else toast.error(r.error ?? t('Échec'));
      reload();
    } catch (e) { toast.error((e as Error).message); } finally { setTesting(null); }
  }
  const field = 'space-y-1 text-xs';
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 p-5 sm:p-8" data-ssh-page>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><ServerIcon className="size-5" />SSH</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('Des machines que tes Circles peuvent piloter en SSH depuis le serveur BotCircle. Chaque machine choisit ses Circles ; par défaut, chaque commande attend ton accord.')}</p>
        </div>
        {rows === null && <LoaderIcon className="animate-spin" />}
        {rows?.map((row) => (
          <section key={row.id} className="space-y-2 rounded-2xl border p-4" data-ssh-row={row.id}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('size-2 rounded-full', row.status === 'ok' ? 'bg-emerald-500' : row.status === 'error' ? 'bg-destructive' : 'bg-muted-foreground/50')} />
              <p className="font-medium">{row.name}</p>
              <p className="text-muted-foreground text-xs">{row.username}@{row.host}:{row.port}</p>
              <div className="ml-auto flex items-center gap-2"><span className="text-muted-foreground text-xs">{t('Active')}</span><Switch checked={row.enabled} aria-label={t('Active')} onCheckedChange={(enabled) => void api.saveSsh(row.id, { enabled }).then(reload)} /></div>
            </div>
            <p className="flex items-center gap-1.5 text-xs">{row.hostKey ? <><ShieldCheckIcon className="size-3.5 text-emerald-600" /><span className="font-mono text-muted-foreground">{row.hostKey}</span></> : <><ShieldAlertIcon className="size-3.5 text-amber-600" />{t('Hôte pas encore vérifié')}</>}</p>
            <p className="text-muted-foreground text-xs">{row.agents.length ? t('Circles autorisés : {v0}', { v0: row.agents.map((id) => agents.find((a) => a.id === id)?.name ?? '?').join(', ') }) : t('Aucun Circle autorisé')} · {row.approval === 'ask' ? t('chaque commande attend ton accord') : t('accès shell complet, sans validation')}{row.lastOkAt ? ` · ${t('dernière connexion {v0}', { v0: formatDateTime(row.lastOkAt) })}` : ''}</p>
            {row.lastError && <p className="text-destructive text-xs">{row.lastError}</p>}
            {pending?.id === row.id && (
              <div className="space-y-2 rounded-xl border border-amber-500/40 p-3 text-xs" role="alert">
                <p>{t('Première connexion : vérifie que cette empreinte est bien celle de la machine (ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub).')}</p>
                <p className="font-mono">{pending.hostKey}</p>
                <Button size="sm" onClick={() => void test(row.id, true)}>{t('Faire confiance à cet hôte')}</Button>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" disabled={testing === row.id} onClick={() => void test(row.id)}>{testing === row.id && <LoaderIcon className="animate-spin" />}{t('Tester')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setDraft({ ...empty, id: row.id, name: row.name, description: row.description, host: row.host, port: String(row.port), username: row.username, auth: row.auth, agents: row.agents, approval: row.approval })}>{t('Modifier')}</Button>
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => { if (confirm(t('Supprimer {v0} ?', { v0: row.name }))) void api.deleteSsh(row.id).then(reload); }}>{t('Supprimer')}</Button>
            </div>
          </section>
        ))}
        {!draft && <Button variant="outline" onClick={() => setDraft({ ...empty })}><PlusIcon />{t('Ajouter une machine')}</Button>}
        {draft && (
          <form className="space-y-3 rounded-2xl border p-4" data-ssh-form onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={field}>{t('Nom')}<Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t('Serveur maison')} /></label>
              <label className={field}>{t('Adresse')}<Input value={draft.host} onChange={(e) => setDraft({ ...draft, host: e.target.value })} placeholder="192.168.1.10" /></label>
              <label className={field}>{t('Utilisateur')}<Input value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} autoComplete="off" /></label>
              <label className={field}>{t('Port')}<Input value={draft.port} inputMode="numeric" onChange={(e) => setDraft({ ...draft, port: e.target.value })} /></label>
            </div>
            <label className={cn(field, 'block')}>{t('Description (facultatif)')}<Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
            <div className="flex gap-2 text-xs">
              {(['key', 'password'] as const).map((auth) => <Button key={auth} type="button" size="sm" variant={draft.auth === auth ? 'secondary' : 'ghost'} onClick={() => setDraft({ ...draft, auth })}>{auth === 'key' ? t('Clé privée') : t('Mot de passe')}</Button>)}
            </div>
            {draft.auth === 'key' ? (<>
              <label className={cn(field, 'block')}>{t('Clé privée')}<Textarea rows={4} className="font-mono text-xs" value={draft.privateKey} onChange={(e) => setDraft({ ...draft, privateKey: e.target.value })} placeholder={draft.id ? t('Laisse vide pour garder la clé enregistrée') : '-----BEGIN OPENSSH PRIVATE KEY-----'} /></label>
              <label className={cn(field, 'block')}>{t('Phrase de passe (facultatif)')}<Input type="password" value={draft.passphrase} onChange={(e) => setDraft({ ...draft, passphrase: e.target.value })} autoComplete="off" /></label>
            </>) : <label className={cn(field, 'block')}>{t('Mot de passe')}<Input type="password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} placeholder={draft.id ? t('Laisse vide pour garder le mot de passe enregistré') : ''} autoComplete="off" /></label>}
            <fieldset className="space-y-1.5 text-sm">
              <legend className="mb-1 text-xs">{t('Circles autorisés')}</legend>
              {agents.map((a) => <label key={a.id} className="flex items-center gap-2"><input type="checkbox" checked={draft.agents.includes(a.id)} onChange={(e) => setDraft({ ...draft, agents: e.target.checked ? [...draft.agents, a.id] : draft.agents.filter((id) => id !== a.id) })} />{a.name}</label>)}
            </fieldset>
            <fieldset className="space-y-1.5 text-sm">
              <legend className="mb-1 text-xs">{t('Validation')}</legend>
              <label className="flex items-center gap-2"><input type="radio" checked={draft.approval === 'ask'} onChange={() => setDraft({ ...draft, approval: 'ask' })} />{t('Chaque commande attend mon accord (recommandé)')}</label>
              <label className="flex items-center gap-2"><input type="radio" checked={draft.approval === 'auto'} onChange={() => setDraft({ ...draft, approval: 'auto' })} />{t('Exécuter directement : accès shell complet, aucune commande n’est filtrée')}</label>
            </fieldset>
            <p className="text-muted-foreground text-xs">{t('Les secrets sont chiffrés sur le serveur et ne sont plus jamais affichés, ni aux Circles, ni dans les journaux.')}</p>
            <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setDraft(null)}>{t('Annuler')}</Button><Button type="submit" disabled={busy}>{busy && <LoaderIcon className="animate-spin" />}{t('Enregistrer')}</Button></div>
          </form>
        )}
      </div>
    </div>
  );
}
