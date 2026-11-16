import { useCallback, useEffect, useState } from 'react';
import { HouseIcon, LoaderIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, type HaInstance } from '@/lib/api';
import { useStore } from '@/lib/store';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type Access = 'none' | 'read' | 'control';
const ACCESS: { value: Access; label: string }[] = [{ value: 'none', label: 'Aucun' }, { value: 'read', label: 'Lecture' }, { value: 'control', label: 'Pilotage' }];

/**
 * #39: Home Assistant through its official MCP server. Connect with Home Assistant's own sign-in (or a long-lived
 * token), then decide, Circle by Circle, who may read or drive the home. Checked on the server at every call.
 */
export function HomeAssistantPage() {
  const agents = useStore((s) => s.agents);
  const [rows, setRows] = useState<HaInstance[] | null>(null);
  const [url, setUrl] = useState(''), [mode, setMode] = useState<'assist' | 'full'>('assist'), [token, setToken] = useState(''), [useToken, setUseToken] = useState(false), [busy, setBusy] = useState(false);
  const reload = useCallback(() => { api.haInstances().then(setRows).catch((e) => toast.error(e.message)); }, []);
  useEffect(() => {
    reload();
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
    if (params.get('connected')) toast.success(t('Home Assistant connecté'));
    if (params.get('error')) toast.error(params.get('error')!);
  }, [reload]);
  async function connect() {
    setBusy(true);
    try {
      if (useToken) { await api.haToken({ url, mode, token }); setToken(''); toast.success(t('Home Assistant connecté')); reload(); }
      else { const { authorizeUrl } = await api.haOAuth({ url, mode }); location.assign(authorizeUrl); }
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  async function policy(row: HaInstance, change: Partial<HaInstance['policy']>) {
    try { await api.haPolicy(row.id, change); reload(); } catch (e) { toast.error((e as Error).message); }
  }
  const select = (value: Access, onChange: (v: Access) => void, label: string) => (
    <div className="flex gap-1" role="radiogroup" aria-label={label}>
      {ACCESS.map((a) => <button key={a.value} type="button" role="radio" aria-checked={value === a.value} onClick={() => onChange(a.value)} className={cn('rounded-full px-2.5 py-1 text-xs', value === a.value ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/60')}>{t(a.label)}</button>)}
    </div>
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 p-5 sm:p-8" data-ha-page>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><HouseIcon className="size-5" />Home Assistant</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('Par le serveur MCP officiel de Home Assistant. BotCircle s’y connecte depuis son serveur : sur ton réseau local, il n’a pas besoin d’être exposé sur Internet.')}</p>
        </div>
        {rows === null && <LoaderIcon className="animate-spin" />}
        {rows?.map((row) => (
          <section key={row.id} className="space-y-3 rounded-2xl border p-4" data-ha-row>
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('size-2 rounded-full', row.status === 'ok' ? 'bg-emerald-500' : 'bg-destructive')} />
              <p className="font-medium">{row.name}</p>
              <p className="text-muted-foreground text-xs">{row.base} · {row.mode === 'assist' ? t('Assist (entités exposées)') : t('Complet')} · {row.auth === 'oauth' ? t('connexion Home Assistant') : t('jeton d’accès')}</p>
              <Button size="sm" variant="ghost" className="ml-auto text-destructive" onClick={() => { if (confirm(t('Déconnecter {v0} ?', { v0: row.name }))) void api.haDelete(row.id).then(reload); }}>{t('Déconnecter')}</Button>
            </div>
            {row.lastError && <p className="text-destructive text-xs">{row.lastError}</p>}
            <p className="text-muted-foreground text-xs">{t('Outils proposés par Home Assistant : {v0}', { v0: row.tools.join(', ') || '—' })}</p>
            <div className="divide-y rounded-xl border" data-ha-matrix>
              {agents.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm"><span>{a.name}</span>{select(row.policy.agents[a.id] ?? 'none', (v) => void policy(row, { agents: { ...row.policy.agents, [a.id]: v } }), a.name)}</div>
              ))}
              <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm"><span>{t('Chats généraux')}</span>{select(row.policy.chats, (v) => void policy(row, { chats: v }), t('Chats généraux'))}</div>
            </div>
            <label className="block space-y-1 text-xs">{t('Pièces autorisées pour le pilotage (vide : toutes celles exposées)')}
              <Input defaultValue={row.policy.areas.join(', ')} placeholder={t('salon, cuisine')} onBlur={(e) => void policy(row, { areas: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })} />
            </label>
            <p className="text-muted-foreground text-xs">{t('Toujours soumis à ta validation : {v0}.', { v0: row.policy.sensitive.join(', ') })} {t('Home Assistant limite en plus ce que son compte et ses entités exposées permettent.')}</p>
          </section>
        ))}
        <form className="space-y-3 rounded-2xl border p-4" data-ha-connect onSubmit={(e) => { e.preventDefault(); void connect(); }}>
          <p className="font-medium text-sm">{rows?.length ? t('Connecter une autre instance') : t('Connecter Home Assistant')}</p>
          <label className="block space-y-1 text-xs">{t('Adresse de Home Assistant')}<Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://homeassistant.local:8123" /></label>
          <div className="flex gap-2 text-xs">
            <Button type="button" size="sm" variant={mode === 'assist' ? 'secondary' : 'ghost'} onClick={() => setMode('assist')}>{t('Assist (recommandé)')}</Button>
            <Button type="button" size="sm" variant={mode === 'full' ? 'secondary' : 'ghost'} onClick={() => setMode('full')}>{t('Complet')}</Button>
          </div>
          <p className="text-muted-foreground text-xs">{mode === 'assist' ? t('/api/mcp/assist : seulement les entités que tu exposes à Assist dans Home Assistant.') : t('/api/mcp : les outils de l’API choisie dans l’intégration MCP de Home Assistant.')}</p>
          {useToken && <label className="block space-y-1 text-xs">{t('Jeton d’accès longue durée')}<Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={t('Profil → Sécurité → Jetons d’accès longue durée')} /></label>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" className="text-muted-foreground text-xs underline-offset-2 hover:underline" onClick={() => setUseToken(!useToken)}>{useToken ? t('Se connecter avec Home Assistant plutôt') : t('Utiliser un jeton d’accès à la place')}</button>
            <Button type="submit" disabled={busy || !url.trim() || (useToken && !token.trim())}>{busy && <LoaderIcon className="animate-spin" />}{useToken ? t('Connecter') : t('Se connecter avec Home Assistant')}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
