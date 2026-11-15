import { useEffect, useState } from 'react';
import { BrainIcon, CheckIcon, ChevronDownIcon, GlobeIcon } from 'lucide-react';
import type { ChatDTO, ModelConfig } from '@opendots/shared';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api, type ModelInfo } from '@/lib/api';
import { setStoreChats, useStore } from '@/lib/store';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ModelPicker } from '../model-picker';

const modelCache = new Map<string, Promise<ModelInfo[]>>();
const modelsOf = (provider: ModelConfig['provider']) => {
  if (!modelCache.has(provider)) modelCache.set(provider, (provider === 'codex' ? api.codexModels() : provider === 'ollama' ? api.ollamaModels() : api.openrouterModels()).catch(() => []));
  return modelCache.get(provider)!;
};
const shortName = (model: string) => model.split('/').pop() ?? model;

/**
 * The chat's own controls, in the field: its model (for the next answers), the reasoning effort when the model has
 * one, and web search. Web search off is enforced on the server: the model is not given the web tools.
 */
export function ChatControls({ chat }: { chat: ChatDTO }) {
  const chats = useStore((s) => s.chats);
  const [picking, setPicking] = useState(false);
  const [provider, setProvider] = useState<ModelConfig['provider']>(chat.effectiveModel.provider);
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const model = chat.effectiveModel;
  useEffect(() => { let active = true; void modelsOf(model.provider).then((list) => active && setInfo(list.find((m) => m.id === model.model) ?? null)); return () => { active = false; }; }, [model.provider, model.model]);
  async function patch(change: { model?: ModelConfig | null; webSearch?: boolean }) {
    try { const updated = await api.updateChat(chat.id, change); setStoreChats(chats.map((c) => (c.id === updated.id ? updated : c))); }
    catch (e) { toast.error((e as Error).message); }
  }
  const efforts = ['low', 'medium', 'high'] as const;
  return (
    <div className="flex min-w-0 items-center gap-0.5" data-chat-controls>
      <button type="button" onClick={() => setPicking(true)} className="flex min-w-0 items-center gap-1 rounded-full px-2.5 py-1 text-muted-foreground text-xs hover:bg-accent hover:text-foreground" aria-label={t('Modèle de ce chat')} title={model.model} data-chat-model>
        <span className="max-w-40 truncate">{info?.name ?? shortName(model.model)}</span><ChevronDownIcon className="size-3 shrink-0" />
      </button>
      {info?.reasoning && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="flex items-center gap-1 rounded-full px-2 py-1 text-muted-foreground text-xs hover:bg-accent hover:text-foreground" aria-label={t('Effort de raisonnement')} data-chat-effort>
              <BrainIcon className="size-3.5" />{model.reasoning ? t(model.reasoning === 'low' ? 'Faible' : model.reasoning === 'medium' ? 'Moyen' : 'Élevé') : t('Auto')}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {[null, ...efforts].map((value) => (
              <DropdownMenuItem key={value ?? 'auto'} onSelect={() => void patch({ model: { ...model, reasoning: value } })}>
                {(model.reasoning ?? null) === value ? <CheckIcon /> : <span className="size-4" />}{value ? t(value === 'low' ? 'Faible' : value === 'medium' ? 'Moyen' : 'Élevé') : t('Auto')}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <button type="button" aria-pressed={chat.webSearch} onClick={() => void patch({ webSearch: !chat.webSearch })} data-chat-web={chat.webSearch ? 'on' : 'off'}
        title={chat.webSearch ? t('Recherche web activée pour ce chat') : t('Recherche web coupée pour ce chat')}
        className={cn('flex items-center gap-1 rounded-full px-2 py-1 text-xs', chat.webSearch ? 'bg-primary/10 text-primary hover:bg-primary/15' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}>
        <GlobeIcon className="size-3.5" />{t('Web')}
      </button>
      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('Modèle de ce chat')}</DialogTitle>
            <DialogDescription>{t('Pour les prochaines réponses de ce chat ; chaque réponse garde le modèle qui l’a écrite.')}</DialogDescription>
          </DialogHeader>
          <div className="flex gap-1">
            {(['openrouter', 'ollama', 'codex'] as const).map((value) => <button key={value} type="button" aria-pressed={provider === value} onClick={() => setProvider(value)} className={cn('rounded-full px-3 py-1 text-xs', provider === value ? 'bg-secondary font-medium' : 'text-muted-foreground hover:text-foreground')}>{value === 'openrouter' ? 'OpenRouter' : value === 'ollama' ? 'Ollama' : 'Codex'}</button>)}
          </div>
          <ModelPicker value={model.provider === provider ? model.model : null} provider={provider} onChange={(picked) => { void patch({ model: { provider: picked.provider, model: picked.id, reasoning: picked.reasoning ? model.reasoning ?? null : null } }); setPicking(false); }} />
          {chat.model && <button type="button" className="text-left text-muted-foreground text-xs hover:text-foreground" onClick={() => { void patch({ model: null }); setPicking(false); }}>{t('Revenir au modèle par défaut')}</button>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
