import { useEffect, useState } from 'react';
import { PencilIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAccount } from '@/lib/account';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { AccountAvatar } from './account-avatar';

/**
 * #54: the compact profile card at the top of Settings. The name is how every Circle and chat addresses the user;
 * without one, nothing is guessed from the email.
 */
export function ProfileCard() {
  const account = useAccount();
  const [profile, setProfile] = useState<{ firstName: string | null; lastName: string | null } | null>(null);
  const [editing, setEditing] = useState(false), [leaving, setLeaving] = useState(false);
  const [first, setFirst] = useState(''), [last, setLast] = useState(''), [saving, setSaving] = useState(false);
  useEffect(() => { api.profile().then(setProfile).catch(() => setProfile({ firstName: null, lastName: null })); }, []);
  const name = [profile?.firstName, profile?.lastName].filter(Boolean).join(' ');
  function open() { setFirst(profile?.firstName ?? ''); setLast(profile?.lastName ?? ''); setEditing(true); }
  async function save() {
    setSaving(true);
    try { setProfile(await api.setProfile({ firstName: first.trim() || null, lastName: last.trim() || null })); setEditing(false); toast.success(t('Nom enregistré : tes Circles l’utiliseront.')); }
    catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  }
  return (
    <section className="flex flex-wrap items-center gap-4 rounded-2xl border p-5" data-profile-card>
      <AccountAvatar className="size-14 text-lg" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className={name ? 'truncate font-medium' : 'truncate text-muted-foreground'}>{name || t('Ajoute ton prénom')}</p>
          <Button size="icon" variant="ghost" className="size-7 rounded-full text-muted-foreground" aria-label={t('Modifier ton nom')} onClick={open}><PencilIcon className="size-3.5" /></Button>
        </div>
        <p className="truncate text-xs text-muted-foreground">{account?.email}</p>
      </div>
      <Button variant="outline" size="sm" onClick={() => setLeaving(true)}>{t('Se déconnecter')}</Button>
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('Ton nom')}</DialogTitle>
            <DialogDescription>{t('Tes Circles et tes chats t’appelleront par ton prénom. Laisse vide si tu préfères ne pas le donner.')}</DialogDescription>
          </DialogHeader>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <Input autoFocus value={first} maxLength={60} onChange={(e) => setFirst(e.target.value)} placeholder={t('Prénom')} aria-label={t('Prénom')} />
            <Input value={last} maxLength={60} onChange={(e) => setLast(e.target.value)} placeholder={t('Nom (facultatif)')} aria-label={t('Nom (facultatif)')} />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>{t('Annuler')}</Button>
              <Button type="submit" disabled={saving}>{t('Enregistrer')}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={leaving} onOpenChange={setLeaving}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t('Se déconnecter ?')}</DialogTitle><DialogDescription>{t('Tes Circles continuent de travailler sur le serveur.')}</DialogDescription></DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setLeaving(false)}>{t('Annuler')}</Button>
            <Button variant="destructive" onClick={() => api.logout().then(() => location.reload())}>{t('Se déconnecter')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
