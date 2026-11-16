import { useCallback, useEffect, useState } from 'react';
import { BellIcon, LoaderIcon, MonitorSmartphoneIcon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { api, type NotificationCategory, type NotificationPrefs, type PushDevice } from '@/lib/api';
import { disablePush, enablePush, pushSupported, thisBrowserPushId } from '@/lib/push';
import { useStore } from '@/lib/store';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/utils';

const CATEGORY_LABELS: [NotificationCategory, string, string][] = [
  ['messages', 'Messages et réponses', 'Quand un Circle ou un chat a fini de répondre.'],
  ['tasks', 'Résultats des tâches', 'Une tâche échouée, en pause ou qui attend ton intervention.'],
  ['approvals', 'Validations', 'Une action attend ton accord, ou un Circle te pose une question.'],
  ['code', 'Code', 'Les sessions OpenCode terminées, en échec ou en attente.'],
  ['scheduled', 'Activités programmées', 'Les rappels et surveillances qui ont quelque chose à te dire.'],
];

/**
 * #64: Settings → Notifications. This browser's push (asked only on a click), what to be told about, quiet hours,
 * lock-screen preview, muted Circles and chats, and every device / browser that receives them.
 */
export function NotificationsPage() {
  const agents = useStore((s) => s.agents), chats = useStore((s) => s.chats);
  const [prefs, setPrefsState] = useState<NotificationPrefs | null>(null), [devices, setDevices] = useState<PushDevice[] | null>(null);
  const [busy, setBusy] = useState(false), [here, setHere] = useState(thisBrowserPushId());
  const permission = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  const reload = useCallback(() => { api.notificationPrefs().then(setPrefsState).catch((e) => toast.error(e.message)); api.pushSubscriptions().then(setDevices).catch(() => setDevices([])); }, []);
  useEffect(reload, [reload]);
  const save = (patch: Partial<NotificationPrefs>) => void api.setNotificationPrefs(patch).then(setPrefsState).catch((e) => toast.error(e.message));
  async function toggleHere(on: boolean) {
    setBusy(true);
    if (on) {
      const r = await enablePush();
      if (r.ok) toast.success(t('Notifications activées sur ce navigateur.'));
      else toast.error(r.reason === 'unsupported' ? t('Ce navigateur ne prend pas en charge les notifications push (il faut HTTPS et un navigateur compatible).') : r.reason === 'denied' ? t('Le navigateur refuse les notifications : autorise-les dans les réglages du site.') : r.message ?? t('Échec'));
    } else { await disablePush(); toast.success(t('Notifications coupées sur ce navigateur.')); }
    setHere(thisBrowserPushId()); setBusy(false); reload();
  }
  const test = async (id?: string) => {
    try { const r = await api.testPush(id); const bad = r.results.filter((x) => !x.ok); bad.length ? toast.error(t('{count} appareil(s) en échec : {v0}', { count: bad.length, v0: bad[0].error ?? '' })) : toast.success(t('Notification de test envoyée.')); }
    catch (e) { toast.error((e as Error).message); }
  };
  if (!prefs) return <div className="flex flex-1 items-center justify-center"><LoaderIcon className="animate-spin" /></div>;
  const row = 'flex items-start gap-3 py-3';
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 p-5 sm:p-8" data-notifications-page>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><BellIcon className="size-5" />{t('Notifications')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('Seulement ce qui mérite ton attention : réponses terminées, tâches qui ont besoin de toi, validations. Tout reste aussi dans Activité et Validations.')}</p>
        </div>

        <section className="rounded-2xl border px-4">
          <div className={row}>
            <div className="min-w-0 flex-1"><p className="font-medium text-sm">{t('Ce navigateur')}</p>
              <p className="text-muted-foreground text-xs">{!pushSupported() ? t('Notifications push non prises en charge ici (HTTPS et navigateur compatible requis). Les notifications restent visibles dans l’app.') : permission === 'denied' ? t('Bloquées par le navigateur : autorise les notifications dans les réglages du site, puis réessaie.') : here ? t('Activées : tu es prévenu même onglet fermé.') : t('Désactivées sur ce navigateur.')}</p></div>
            <Switch checked={Boolean(here)} disabled={busy || !pushSupported()} onCheckedChange={(on) => void toggleHere(on)} aria-label={t('Notifications sur ce navigateur')} />
          </div>
          <div className={`${row} border-t`}>
            <div className="min-w-0 flex-1"><p className="font-medium text-sm">{t('Toutes les notifications')}</p><p className="text-muted-foreground text-xs">{t('Interrupteur général pour tous tes appareils.')}</p></div>
            <Switch checked={prefs.enabled} onCheckedChange={(enabled) => save({ enabled })} aria-label={t('Toutes les notifications')} />
          </div>
        </section>

        <section className="rounded-2xl border px-4" aria-label={t('Catégories')}>
          {CATEGORY_LABELS.map(([key, label, note], i) => (
            <div key={key} className={`${row} ${i ? 'border-t' : ''}`}>
              <div className="min-w-0 flex-1"><p className="font-medium text-sm">{t(label)}</p><p className="text-muted-foreground text-xs">{t(note)}</p></div>
              <Switch checked={prefs.categories[key]} disabled={!prefs.enabled} onCheckedChange={(on) => save({ categories: { ...prefs.categories, [key]: on } })} aria-label={t(label)} />
            </div>
          ))}
        </section>

        <section className="space-y-3 rounded-2xl border p-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1"><p className="font-medium text-sm">{t('Aperçu sur l’écran verrouillé')}</p><p className="text-muted-foreground text-xs">{t('Désactivé : une ligne générique (« Nouveau message ») au lieu du contenu.')}</p></div>
            <Switch checked={prefs.preview} onCheckedChange={(preview) => save({ preview })} aria-label={t('Aperçu sur l’écran verrouillé')} />
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(prefs.quietHours)} onChange={(e) => save({ quietHours: e.target.checked ? { start: '22:00', end: '07:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : null })} />{t('Heures calmes')}</label>
            {prefs.quietHours && <>
              <input type="time" aria-label={t('Début')} value={prefs.quietHours.start} onChange={(e) => save({ quietHours: { ...prefs.quietHours!, start: e.target.value } })} className="h-8 rounded-md border bg-background px-2" />
              <span>–</span>
              <input type="time" aria-label={t('Fin')} value={prefs.quietHours.end} onChange={(e) => save({ quietHours: { ...prefs.quietHours!, end: e.target.value } })} className="h-8 rounded-md border bg-background px-2" />
              <span className="text-muted-foreground text-xs">{prefs.quietHours.timezone}</span>
            </>}
          </div>
          <p className="text-muted-foreground text-xs">{t('Pendant les heures calmes, rien ne sonne : tout reste dans Activité et Validations. Le mode Ne pas déranger de ton appareil s’applique aussi.')}</p>
        </section>

        <section className="space-y-2 rounded-2xl border p-4">
          <p className="font-medium text-sm">{t('En sourdine')}</p>
          <div className="flex flex-wrap gap-1.5">
            {agents.map((a) => { const muted = prefs.mutedAgents.includes(a.id); return <button key={a.id} type="button" aria-pressed={muted} onClick={() => save({ mutedAgents: muted ? prefs.mutedAgents.filter((x) => x !== a.id) : [...prefs.mutedAgents, a.id] })} className={`rounded-full border px-2.5 py-1 text-xs ${muted ? 'border-foreground bg-foreground text-background' : 'hover:bg-accent'}`}>{a.name}</button>; })}
            {chats.slice(0, 20).map((c) => { const muted = prefs.mutedChats.includes(c.id); return <button key={c.id} type="button" aria-pressed={muted} onClick={() => save({ mutedChats: muted ? prefs.mutedChats.filter((x) => x !== c.id) : [...prefs.mutedChats, c.id] })} className={`rounded-full border px-2.5 py-1 text-xs ${muted ? 'border-foreground bg-foreground text-background' : 'hover:bg-accent'}`}>{c.title}</button>; })}
          </div>
          <p className="text-muted-foreground text-xs">{t('Un Circle ou un chat en sourdine ne t’envoie plus de notification ; ses validations restent dans Validations.')}</p>
        </section>

        <section className="space-y-2">
          <div className="flex items-center"><p className="flex-1 font-medium text-sm">{t('Appareils et navigateurs')}</p><Button size="sm" variant="secondary" disabled={!devices?.length} onClick={() => void test()}>{t('Envoyer un test')}</Button></div>
          {devices?.length === 0 && <p className="rounded-2xl border p-4 text-muted-foreground text-sm">{t('Aucun appareil. Active les notifications sur ce navigateur, ou dans l’app Android (Réglages › Notifications).')}</p>}
          {devices?.map((d) => (
            <div key={d.id} className="flex items-center gap-3 rounded-2xl border px-4 py-3" data-push-device={d.id}>
              <MonitorSmartphoneIcon className="size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1 text-sm"><p className="truncate">{d.label || d.endpointHost}{d.id === here && <span className="ml-1.5 text-muted-foreground text-xs">· {t('ce navigateur')}</span>}</p>
                <p className="truncate text-muted-foreground text-xs">{d.kind === 'unifiedpush' ? 'UnifiedPush' : 'Web Push'} · {d.endpointHost} · {d.lastOkAt ? t('dernier envoi {v0}', { v0: formatDateTime(d.lastOkAt) }) : t('jamais utilisé')}{d.failures ? ` · ${t('{count} échec(s)', { count: d.failures })}` : ''}</p></div>
              <Button size="sm" variant="ghost" onClick={() => void test(d.id)}>{t('Tester')}</Button>
              <Button size="icon" variant="ghost" aria-label={t('Retirer cet appareil')} onClick={() => void api.removePushSubscription(d.id).then(() => { if (d.id === here) void disablePush().then(() => setHere(null)); reload(); })}><Trash2Icon className="size-4" /></Button>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
