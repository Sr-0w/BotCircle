import { useEffect, useState } from 'react';
import { CheckCircle2Icon, KeyRoundIcon, LinkIcon, LoaderIcon, UnlinkIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAccount } from '@/lib/account';
import { api, startSso, type LinkedIdentity, type OidcAdminView, type SsoPublic } from '@/lib/api';
import { askConfirm } from '@/lib/confirm';
import { t } from '@/lib/i18n';

/**
 * #77 — Settings → Profile: the identities linked to this account (link / unlink, never a token), and for
 * administrators the server's single sign-on (OIDC) configuration.
 */
export function SsoSettings() {
  const account = useAccount();
  const [sso, setSso] = useState<SsoPublic | null>(null);
  useEffect(() => { api.me().then((r) => setSso(r.sso ?? null)).catch(() => {}); }, []);
  useEffect(() => {
    // Back from the IdP after linking.
    if (/[?&]sso=linked\b/.test(location.hash)) { toast.success(t('Compte lié : tu peux maintenant te connecter avec la connexion unique.')); history.replaceState(null, '', location.pathname + location.hash.replace(/[?&]sso=linked\b/, '')); }
  }, []);
  return <>
    {sso?.enabled && <LinkedIdentities label={sso.label} />}
    {account?.role === 'admin' && <AdminSso onSaved={(view) => setSso({ enabled: view.enabled && !!view.issuer && !!view.clientId, label: view.label, localLogin: view.localLogin })} />}
  </>;
}

function LinkedIdentities({ label }: { label: string }) {
  const [data, setData] = useState<{ identities: LinkedIdentity[]; hasPassword: boolean } | null>(null);
  const load = () => api.identities().then(setData).catch(() => setData({ identities: [], hasPassword: true }));
  useEffect(() => { void load(); }, []);
  async function unlink(identity: LinkedIdentity) {
    if (!(await askConfirm({ title: t('Délier ce compte ?'), body: t('Tu ne pourras plus te connecter avec {label} sur ce compte, jusqu’à une nouvelle liaison. Tes Circles, chats et réglages restent intacts.', { label }), confirm: t('Délier'), destructive: true }))) return;
    try { await api.unlinkIdentity(identity.issuer, identity.subject); toast.success(t('Compte délié.')); await load(); }
    catch (e) { toast.error((e as Error).message); }
  }
  return <section className="space-y-3 rounded-2xl border p-5" data-sso-identities>
    <div><h2 className="font-medium">{t('Connexion unique')}</h2><p className="text-sm text-muted-foreground">{t('Comptes du fournisseur d’identité liés à ton compte BotCircle.')}</p></div>
    {!data ? <LoaderIcon className="size-4 animate-spin text-muted-foreground" /> : <>
      {data.identities.map((i) => <div key={i.issuer + i.subject} className="flex items-center gap-3 rounded-xl bg-muted/40 px-3 py-2.5 text-sm">
        <CheckCircle2Icon className="size-4 shrink-0 text-success" />
        <span className="min-w-0 flex-1"><span className="block truncate">{i.email ?? label}</span><span className="block truncate text-xs text-muted-foreground">{new URL(i.issuer).host}{i.lastLoginAt ? ' · ' + t('dernière connexion {date}', { date: new Date(i.lastLoginAt).toLocaleString() }) : ''}</span></span>
        <Button size="sm" variant="ghost" onClick={() => unlink(i)} disabled={!data.hasPassword && data.identities.length <= 1} title={!data.hasPassword && data.identities.length <= 1 ? t('Ce compte n’a pas de mot de passe : c’est sa seule façon de se connecter.') : undefined}><UnlinkIcon />{t('Délier')}</Button>
      </div>)}
      {!data.identities.length && <Button variant="outline" onClick={() => startSso('link')}><LinkIcon />{t('Lier mon compte {label}', { label })}</Button>}
      {!data.identities.length && <p className="text-xs text-muted-foreground">{t('Tu confirmeras ton identité chez {label}. Rien n’est fusionné automatiquement, même si l’adresse e-mail est la même.', { label })}</p>}
    </>}
  </section>;
}

const list = (value: string) => value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

function AdminSso({ onSaved }: { onSaved: (view: OidcAdminView) => void }) {
  const [view, setView] = useState<OidcAdminView | null>(null);
  const [form, setForm] = useState({ enabled: false, issuer: '', clientId: '', clientSecret: '', scopes: 'openid profile email', label: 'Authentik', jit: false, localLogin: true, allowedDomains: '', allowedGroups: '', adminGroups: '', groupsClaim: 'groups', sessionHours: 12 });
  const [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [testing, setTesting] = useState(false);
  const [discovery, setDiscovery] = useState<Record<string, unknown> | null>(null), [testError, setTestError] = useState('');
  const fill = (v: OidcAdminView) => { setView(v); setForm({ enabled: v.enabled, issuer: v.issuer, clientId: v.clientId, clientSecret: '', scopes: v.scopes, label: v.label, jit: v.jit, localLogin: v.localLogin, allowedDomains: v.allowedDomains.join(', '), allowedGroups: v.allowedGroups.join(', '), adminGroups: v.adminGroups.join(', '), groupsClaim: v.groupsClaim, sessionHours: v.sessionHours }); };
  useEffect(() => { api.oidcConfig().then(fill).catch(() => {}); }, []);
  if (!view) return null;
  const locked = view.source === 'environment';
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  async function test() {
    setTesting(true); setTestError(''); setDiscovery(null);
    try { setDiscovery(await api.testOidc(form.issuer)); } catch (e) { setTestError((e as Error).message); } finally { setTesting(false); }
  }
  async function save() {
    setBusy(true);
    try {
      const saved = await api.saveOidcConfig({ enabled: form.enabled, issuer: form.issuer, clientId: form.clientId, ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}), scopes: form.scopes, label: form.label, jit: form.jit, localLogin: form.localLogin, allowedDomains: list(form.allowedDomains), allowedGroups: list(form.allowedGroups), adminGroups: list(form.adminGroups), groupsClaim: form.groupsClaim, sessionHours: Number(form.sessionHours) || 12, currentPassword: password });
      fill(saved); onSaved(saved); setPassword(''); toast.success(t('Connexion unique enregistrée.'));
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  const field = (id: keyof typeof form, label: string, hint?: string, type = 'text') => <div className="space-y-1.5">
    <Label htmlFor={`oidc-${id}`}>{t(label)}</Label>
    <Input id={`oidc-${id}`} type={type} disabled={locked} value={String(form[id])} onChange={(e) => set(id, (type === 'number' ? Number(e.target.value) : e.target.value) as never)} autoComplete="off" />
    {hint && <p className="text-xs text-muted-foreground">{t(hint)}</p>}
  </div>;
  const copyRow = (label: string, value: string) => <div className="flex items-center gap-2 text-xs"><span className="w-40 shrink-0 text-muted-foreground">{t(label)}</span><code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5">{value}</code><Button size="xs" variant="ghost" onClick={() => { void navigator.clipboard.writeText(value); toast.success(t('Copié.')); }}>{t('Copier')}</Button></div>;
  return <section className="space-y-5 rounded-2xl border p-5" data-sso-admin>
    <div className="flex items-start gap-3"><KeyRoundIcon className="mt-0.5 size-4 shrink-0" /><div className="min-w-0 flex-1"><h2 className="font-medium">{t('Authentification et SSO (administrateur)')}</h2><p className="text-sm text-muted-foreground">{t('Connexion unique OpenID Connect pour tout ce serveur (Authentik ou tout fournisseur OIDC standard). Les jetons du fournisseur ne quittent jamais le serveur.')}</p></div>
      <Switch checked={form.enabled} disabled={locked} onCheckedChange={(v) => set('enabled', v)} aria-label={t('Activer la connexion unique')} /></div>
    {locked && <p className="rounded-xl bg-muted/50 p-3 text-xs">{t('Configuré par les variables du déploiement (OPENDOTS_OIDC_*) : modifiable seulement sur le serveur.')}</p>}
    <div className="space-y-1.5 rounded-xl bg-muted/40 p-3">
      <p className="text-xs font-medium">{t('À saisir chez le fournisseur')}</p>
      {copyRow('URI de redirection', view.callbackUrl)}
      {copyRow('Redirection Android', view.androidRedirect)}
      {copyRow('Après déconnexion', view.postLogoutUrl)}
      <p className="text-xs text-muted-foreground">{t('Type de client : confidentiel. L’application Android passe par le serveur : aucun secret n’est embarqué dans l’app.')}</p>
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2 space-y-1.5"><Label htmlFor="oidc-issuer">{t('Issuer')}</Label>
        <div className="flex gap-2"><Input id="oidc-issuer" disabled={locked} value={form.issuer} onChange={(e) => set('issuer', e.target.value)} placeholder="https://auth.example.com/application/o/botcircle/" autoComplete="off" /><Button variant="outline" onClick={test} disabled={testing || !form.issuer}>{testing && <LoaderIcon className="animate-spin" />}{t('Tester')}</Button></div>
        {testError && <p role="alert" className="text-xs text-destructive">{testError}</p>}
        {discovery && <dl className="space-y-0.5 rounded-xl bg-muted/40 p-3 text-xs" data-oidc-discovery>{Object.entries(discovery).filter(([, v]) => v).map(([k, v]) => <div key={k} className="flex gap-2"><dt className="w-52 shrink-0 text-muted-foreground">{k}</dt><dd className="min-w-0 truncate">{Array.isArray(v) ? v.join(', ') : String(v)}</dd></div>)}</dl>}
      </div>
      {field('clientId', 'Client ID')}
      <div className="space-y-1.5"><Label htmlFor="oidc-secret">{t('Secret client')}</Label><Input id="oidc-secret" type="password" disabled={locked} value={form.clientSecret} onChange={(e) => set('clientSecret', e.target.value)} placeholder={view.hasSecret ? t('Enregistré — laisse vide pour le garder') : ''} autoComplete="new-password" /></div>
      {field('label', 'Texte du bouton', 'Affiché « Continuer avec … » sur l’écran de connexion.')}
      {field('scopes', 'Scopes')}
      {field('groupsClaim', 'Claim des groupes')}
      {field('sessionHours', 'Durée de session SSO (heures)', 'Un compte retiré chez le fournisseur perd l’accès au plus tard à la fin de cette durée.', 'number')}
      {field('allowedGroups', 'Groupes autorisés', 'Vide = tout compte authentifié par le fournisseur. Séparés par des virgules.')}
      {field('adminGroups', 'Groupes administrateurs', 'Vide = aucun rôle déduit des groupes. Réévalué à chaque connexion.')}
      {field('allowedDomains', 'Domaines e-mail autorisés', 'Vide = tous. Exige une adresse vérifiée.')}
    </div>
    <div className="space-y-3">
      <label className="flex items-start gap-3 text-sm"><Switch checked={form.jit} disabled={locked} onCheckedChange={(v) => set('jit', v)} /><span><span className="block">{t('Créer le compte à la première connexion')}</span><span className="block text-xs text-muted-foreground">{t('Sinon, seul un compte existant, lié par son propriétaire, peut se connecter. Jamais de fusion sur l’adresse e-mail.')}</span></span></label>
      <label className="flex items-start gap-3 text-sm"><Switch checked={form.localLogin} disabled={locked} onCheckedChange={(v) => set('localLogin', v)} /><span><span className="block">{t('Garder la connexion par mot de passe')}</span><span className="block text-xs text-muted-foreground">{t('Désactivée = SSO seul. Les administrateurs gardent leur mot de passe comme accès de secours ; OPENDOTS_OIDC=off sur le serveur rouvre tout en cas de panne du fournisseur.')}</span></span></label>
    </div>
    {!locked && <div className="flex flex-wrap items-end gap-3 border-t pt-4">
      <div className="min-w-56 flex-1 space-y-1.5"><Label htmlFor="oidc-reauth">{t('Confirme ton mot de passe')}</Label><Input id="oidc-reauth" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></div>
      <Button onClick={save} disabled={busy}>{busy && <LoaderIcon className="animate-spin" />}{t('Enregistrer')}</Button>
    </div>}
  </section>;
}
