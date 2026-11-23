import { useState } from 'react';
import { LockKeyholeIcon, LoaderIcon, LogInIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, startSso, type SsoPublic } from '@/lib/api';
import type { Account } from '@/lib/account';
import { t } from '@/lib/i18n';

/** #77: plain messages for SSO failures; diagnostics stay in the admin settings and server logs. */
const SSO_ERRORS: Record<string, string> = {
  sso_denied: 'Connexion annulée.',
  sso_expired: 'La connexion a expiré. Recommence.',
  sso_forbidden: 'Ton compte n’est pas autorisé sur ce BotCircle.',
  sso_unlinked: 'Aucun compte BotCircle n’est lié à cette identité. Connecte-toi avec ton mot de passe, puis lie ton compte dans Paramètres → Profil et apparence.',
  sso_conflict: 'Un compte BotCircle utilise déjà cette adresse. Connecte-toi avec ton mot de passe, puis lie ton compte dans tes paramètres.',
  sso_unavailable: 'Le fournisseur d’identité est injoignable. Réessaie plus tard.',
  sso_disabled: 'La connexion unique n’est pas disponible sur ce serveur.',
  sso_misconfigured: 'La connexion unique est mal configurée. Préviens l’administrateur.',
};
function ssoErrorFromUrl() {
  const code = new URLSearchParams(location.search).get('sso_error');
  if (!code) return '';
  history.replaceState(null, '', location.pathname + location.hash); // shown once, not kept in the address
  return SSO_ERRORS[code] ?? 'La connexion unique a échoué. Réessaie.';
}

export function AuthPage({ registrationOpen, sso, onAuthenticated }: { registrationOpen: boolean; sso?: SsoPublic; onAuthenticated: (account: Account) => void }) {
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(() => { const message = ssoErrorFromUrl(); return message ? t(message) : ''; });
  // SSO only: the password form is the administrators' recovery route, folded away.
  const [recovery, setRecovery] = useState(false);
  const ssoOn = !!sso?.enabled, passwordForm = !ssoOn || sso!.localLogin || recovery;
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError('');
    if (register && password !== confirm) { setError(t('Les mots de passe ne correspondent pas.')); return; }
    setBusy(true);
    try { onAuthenticated((await (register ? api.register(email, password) : api.login(email, password))).account); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return <main className="flex min-h-full items-center justify-center p-6 text-center"><p>{t('Ouvre BotCircle en HTTPS pour te connecter en sécurité.')}</p></main>;
  return <main className="flex min-h-full items-center justify-center px-4 py-12">
    <div className="w-full max-w-sm space-y-7">
      <div className="space-y-3 text-center"><LockKeyholeIcon className="mx-auto size-9" /><h1 className="text-2xl font-semibold">BotCircle</h1><h2>{t(register ? 'Créer ton compte' : 'Connecte-toi à ton espace')}</h2><p className="text-sm text-muted-foreground">{t('Tes Circles, tes connexions et ta clé OpenRouter sont privés et propres à ton compte.')}</p></div>
      {ssoOn && !register && <div className="space-y-4" data-sso>
        <Button type="button" variant={passwordForm ? 'outline' : 'default'} className="w-full" disabled={busy} onClick={() => { setBusy(true); startSso(); }}><LogInIcon />{t('Continuer avec {label}', { label: sso!.label })}</Button>
        {passwordForm && <div className="flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" />{t('ou')}<span className="h-px flex-1 bg-border" /></div>}
      </div>}
      {!passwordForm && error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {passwordForm && <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5"><Label htmlFor="login-email">{t('Adresse e-mail')}</Label><Input id="login-email" type="email" autoComplete="username" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="space-y-1.5"><Label htmlFor="login-password">{t('Mot de passe')}</Label><Input id="login-password" type="password" autoComplete={register ? 'new-password' : 'current-password'} required minLength={register ? 12 : undefined} maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} />{register && <p className="text-xs text-muted-foreground">{t('12 caractères minimum. La clé OpenRouter sera demandée après l’inscription.')}</p>}</div>
        {register && <div className="space-y-1.5"><Label htmlFor="login-confirm">{t('Confirmer le mot de passe')}</Label><Input id="login-confirm" type="password" autoComplete="new-password" required maxLength={256} value={confirm} onChange={(e) => setConfirm(e.target.value)} /></div>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" variant={ssoOn && !register ? 'secondary' : 'default'} disabled={busy} className="w-full">{busy && <LoaderIcon className="animate-spin" />}{t(register ? 'Créer mon compte' : 'Se connecter')}</Button>
      </form>}
      {registrationOpen && passwordForm && <Button variant="link" className="w-full" disabled={busy} onClick={() => { setRegister(!register); setPassword(''); setConfirm(''); setError(''); }}>{t(register ? 'Déjà un compte ? Se connecter' : 'Pas encore de compte ? S’inscrire')}</Button>}
      {!passwordForm && <Button variant="link" className="w-full text-xs text-muted-foreground" onClick={() => setRecovery(true)}>{t('Accès administrateur de secours')}</Button>}
    </div>
  </main>;
}
