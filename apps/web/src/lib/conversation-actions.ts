import { toast } from 'sonner';
import { createElement as h } from 'react';
import { api, ApiError } from '@/lib/api';
import { askConfirm } from '@/lib/confirm';
import { t } from '@/lib/i18n';

/**
 * #56: Archive, Restore and Delete for a general chat or a Circle's thread, with the same rules on every screen.
 * Delete always asks first, says what goes and what stays, and handles a running reply or still-active tasks
 * explicitly (the server refuses otherwise).
 */
type Target = { kind: 'chat'; id: string; title: string } | { kind: 'thread'; agentId: string; id: string; agentName: string; current: boolean };

export async function archiveConversation(target: Target): Promise<boolean> {
  try {
    if (target.kind === 'chat') await api.archiveChat(target.id); else await api.archiveThread(target.agentId, target.id);
    toast.success(target.kind === 'chat' ? t('Chat archivé. Retrouve-le dans « Archivés ».') : t('Fil archivé. Retrouve-le dans Journal › Anciens fils.'), {
      action: { label: t('Annuler'), onClick: () => void restoreConversation(target, { quiet: true }) },
    });
    return true;
  } catch (e) { toast.error((e as Error).message); return false; }
}

export async function restoreConversation(target: Target, opts: { quiet?: boolean } = {}): Promise<boolean> {
  try {
    if (target.kind === 'chat') await api.restoreChat(target.id); else await api.restoreThread(target.agentId, target.id);
    if (!opts.quiet) toast.success(target.kind === 'chat' ? t('Chat restauré.') : t('Fil restauré : c’est de nouveau le fil courant.'));
    return true;
  } catch (e) { toast.error((e as Error).message); return false; }
}

export async function deleteConversation(target: Target): Promise<boolean> {
  const what = target.kind === 'chat' ? t('le chat « {v0} »', { v0: target.title }) : target.current ? t('le fil courant de {v0}', { v0: target.agentName }) : t('ce fil archivé de {v0}', { v0: target.agentName });
  const ok = await askConfirm({
    title: t('Supprimer {v0} ?', { v0: what }),
    destructive: true, confirm: t('Supprimer définitivement'),
    body: h('div', { className: 'space-y-2' },
      h('p', null, t('Ses messages, les images et les fichiers que tu y as envoyés seront supprimés. Ce n’est pas réversible : pour simplement le ranger, archive-le.')),
      h('p', { className: 'text-muted-foreground' }, target.kind === 'chat' ? t('Les fichiers créés par les Circles, les tâches et le journal d’activité restent.') : t('Le Circle garde son nom, ses réglages, sa mémoire, ses fichiers et ses autres fils.')),
    ),
  });
  if (!ok) return false;
  const flags: { stopActive?: boolean; confirmTasks?: boolean } = {};
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (target.kind === 'chat') await api.deleteChat(target.id, flags); else await api.deleteThread(target.agentId, target.id, flags);
      toast.success(t('Supprimé.'));
      return true;
    } catch (e) {
      const data = e instanceof ApiError ? e.data : null;
      if (data?.status === 'busy' && !flags.stopActive) {
        if (!await askConfirm({ title: t('Une réponse est en cours'), confirm: t('Arrêter et supprimer'), destructive: true, body: t('La réponse en train d’être écrite sera arrêtée, puis la conversation supprimée.') })) return false;
        flags.stopActive = true; continue;
      }
      if (data?.status === 'active_tasks' && !flags.confirmTasks) {
        const tasks = (data.tasks ?? []) as { title: string }[];
        if (!await askConfirm({
          title: t('{count} tâche(s) encore en cours', { count: tasks.length }), confirm: t('Supprimer quand même'), destructive: true,
          body: h('div', { className: 'space-y-2' },
            h('ul', { className: 'list-disc pl-5' }, tasks.slice(0, 6).map((task, i) => h('li', { key: i }, task.title))),
            h('p', null, t('Elles ne sont pas arrêtées : elles continuent, et leurs résultats restent dans Activité.')),
          ),
        })) return false;
        flags.confirmTasks = true; continue;
      }
      toast.error((e as Error).message); return false;
    }
  }
  return false;
}
