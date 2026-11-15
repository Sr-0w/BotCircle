import { describe, expect, it } from 'vitest';
import { detectApi, normalizeV2Messages, OpencodeHttpError, parsePairingLink, redeemPairingCode } from '../src/opencode/client.ts';

/** Responses recorded from a real `opencode serve` 2.3.0. */
const transcript = [
  { id: 'msg_u1', time: { created: 1 }, text: 'Add sub to math.ts', type: 'user' },
  { id: 'msg_a1', time: { created: 2, completed: 3 }, type: 'assistant', agent: 'build', model: { id: 'z-ai/glm-5.3-flash', providerID: 'openrouter' }, content: [
    { type: 'reasoning', text: 'Let me check if math.ts exists first.' },
    { type: 'tool', id: 't1', name: 'glob', state: { status: 'completed', input: { pattern: 'math.ts' }, content: [{ type: 'text', text: '/p/math.ts' }] }, time: { created: 2 } },
  ] },
  { id: 'msg_a2', time: { created: 4, completed: 5 }, type: 'assistant', agent: 'build', model: { id: 'z-ai/glm-5.3-flash', providerID: 'openrouter' }, content: [
    { type: 'tool', id: 't2', name: 'shell', state: { status: 'running', input: { command: 'cat math.ts' }, metadata: {} }, time: { created: 4 } },
  ] },
  { id: 'msg_a3', time: { created: 6, completed: 7 }, type: 'assistant', agent: 'build', model: { id: 'z-ai/glm-5.3-flash', providerID: 'openrouter' }, content: [{ type: 'text', text: 'Done.' }] },
  { id: 'msg_i', time: { created: 8 }, type: 'idle', outcome: 'succeeded' },
];
const refused = { id: 'msg_a9', time: { created: 9 }, type: 'assistant', agent: 'build', model: { id: 'm', providerID: 'p' }, error: { type: 'aborted', message: 'Step interrupted' }, content: [
  { type: 'tool', id: 't9', name: 'shell', state: { status: 'error', input: { command: 'ls' }, error: { type: 'aborted', message: 'The user declined this tool call' } }, time: { created: 9 } },
] };

describe('OpenCode 2.x', () => {
  it('lit un lien d’appairage, y compris celui d’OpenTunnel, et refuse le reste', () => {
    expect(parsePairingLink('https://8fbd9bdbc0e52373.p6lpt46vhtyp.opentunnel.xyz/auth/connect/ZXcLiAFp9to8r6uD7cWV3w')).toEqual({ baseUrl: 'https://8fbd9bdbc0e52373.p6lpt46vhtyp.opentunnel.xyz', code: 'ZXcLiAFp9to8r6uD7cWV3w' });
    expect(parsePairingLink('  http://192.168.1.20:4096/auth/connect/dVTxa8TdY8Sk5qpPtyrKcQ \n').baseUrl).toBe('http://192.168.1.20:4096');
    expect(() => parsePairingLink('https://example.com/login')).toThrow(OpencodeHttpError);
    expect(() => parsePairingLink('ftp://x/auth/connect/abcdefghij')).toThrow(OpencodeHttpError);
    expect(() => parsePairingLink('pas un lien')).toThrow(/Lien d’appairage invalide/);
  });

  it('échange le code contre un jeton, une seule fois, et lit son échéance', async () => {
    const seen: { url: string; accept: string | null }[] = [];
    let used = false;
    const fetcher: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), accept: new Headers(init?.headers).get('accept') });
      if (used) return new Response('expired', { status: 401 });
      used = true;
      return Response.json({ token: '1797351258.c9idHx_qLC5T6t-KtjG' });
    };
    const { token, expiresAt } = await redeemPairingCode('https://x.opentunnel.xyz', 'ZXcLiAFp9to8r6uD7cWV3w', fetcher);
    expect(token).toBe('1797351258.c9idHx_qLC5T6t-KtjG');
    expect(expiresAt?.toISOString()).toBe(new Date(1797351258 * 1000).toISOString());
    expect(seen[0]).toEqual({ url: 'https://x.opentunnel.xyz/auth/connect/ZXcLiAFp9to8r6uD7cWV3w', accept: 'application/json' });
    await expect(redeemPairingCode('https://x.opentunnel.xyz', 'ZXcLiAFp9to8r6uD7cWV3w', fetcher)).rejects.toThrow(/expiré ou a déjà servi/);
  });

  it('détecte la version : 2.x par /api/info, 1.x sinon, et un refus reste un refus', async () => {
    const v2: typeof fetch = async (input) => (new URL(String(input)).pathname === '/api/info' ? Response.json({ version: '2.3.0', pid: 1, urls: [], paths: { tmp: '/tmp' } }) : new Response('', { status: 404 }));
    const v1: typeof fetch = async (input) => (new URL(String(input)).pathname === '/global/health' ? Response.json({ healthy: true, version: '1.19.5' }) : new Response('', { status: 404 }));
    const denied: typeof fetch = async () => new Response('', { status: 401 });
    const target = { baseUrl: 'https://x', username: 'opencode', password: 't' };
    expect((await detectApi(target, v2)).version).toBe('v2');
    expect((await detectApi(target, v1)).version).toBe('v1');
    await expect(detectApi(target, denied)).rejects.toThrow(/refuse ces identifiants/);
  });

  it('lit la conversation 2.x : une étape par message, titre d’outil lisible, refus expliqué', () => {
    const messages = normalizeV2Messages([...transcript, refused] as never);
    expect(messages.map((m) => `${m.info.role}:${m.info.id}`)).toEqual(['user:msg_u1', 'assistant:msg_a1', 'assistant:msg_a2', 'assistant:msg_a3', 'assistant:msg_a9']);
    expect(messages[1].parts.find((p) => p.type === 'tool')).toMatchObject({ tool: 'glob', state: { status: 'completed', title: 'math.ts', output: '/p/math.ts' } });
    expect(messages[2].parts[0]).toMatchObject({ tool: 'shell', state: { status: 'running', title: 'cat math.ts' } });
    expect(messages[3].parts).toEqual([{ id: 'msg_a3-0', type: 'text', text: 'Done.' }]);
    expect(messages[4].info.error?.data?.message).toBe('The user declined this tool call');
    expect(messages[1].info).toMatchObject({ modelID: 'z-ai/glm-5.3-flash', providerID: 'openrouter' });
  });
});
