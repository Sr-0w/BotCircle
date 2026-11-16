import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server, utils } from 'ssh2';
import { openDatabase, closeDatabase, db, schema } from '../src/db/client.ts';
import { createAgent, mainConversationId } from '../src/agents/repo.ts';
import { executeSsh, getSsh, redact, saveSsh, testSsh, toSshDTO } from '../src/ssh/service.ts';
import { sshTools } from '../src/ssh/tools.ts';
import { resolveApproval } from '../src/approvals/service.ts';
import { eq } from 'drizzle-orm';

/** A real SSH server in the test process: one user, one authorised key, a few commands. */
const hostKey = utils.generateKeyPairSync('ed25519');
const userKey = utils.generateKeyPairSync('ed25519');
const otherKey = utils.generateKeyPairSync('ed25519');
let server: Server; let port = 0; let secondHostKey = utils.generateKeyPairSync('ed25519'); let hostKeyInUse = hostKey.private;
function start(keyPem: string) {
  return new Promise<void>((resolve) => {
    server = new Server({ hostKeys: [keyPem] }, (client) => {
      client.on('error', () => {}); // refused handshakes (untrusted host key) are expected here
      client.on('authentication', (ctx) => {
        const allowed = utils.parseKey(userKey.public) as any;
        if (ctx.method === 'publickey' && ctx.username === 'robin' && ctx.key.algo === allowed.type && Buffer.compare(ctx.key.data, allowed.getPublicSSH()) === 0) return ctx.accept();
        if (ctx.method === 'password' && ctx.username === 'robin' && ctx.password === 'right-password') return ctx.accept();
        ctx.reject(['publickey', 'password']);
      }).on('ready', () => client.on('session', (accept) => accept().on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec();
        if (info.command === 'uptime') { stream.write(' 10:00 up 3 days\n'); stream.exit(0); stream.end(); }
        else if (info.command === 'false') { stream.stderr.write('boom\n'); stream.exit(1); stream.end(); }
        else if (info.command === 'echo-secret') { stream.write('the pass is right-password ok\n'); stream.exit(0); stream.end(); }
        else if (info.command === 'sleep') { /* never ends */ }
        else { stream.stderr.write('unknown\n'); stream.exit(127); stream.end(); }
      })));
    }).listen(0, '127.0.0.1', () => { port = (server.address() as any).port; resolve(); });
  });
}

beforeAll(async () => { await openDatabase({ memory: true }); await start(hostKey.private); });
afterAll(async () => { server.close(); await closeDatabase(); });

describe('#52 : connexions SSH', () => {
  it('clé : l’hôte doit d’abord être vérifié ; ensuite stdout, stderr, code ; aucun secret ne ressort', async () => {
    const row = await saveSsh({ name: 'Serveur maison', host: '127.0.0.1', port, username: 'robin', auth: 'key', privateKey: userKey.private });
    expect(JSON.stringify(toSshDTO(row))).not.toContain('PRIVATE KEY');
    await expect(executeSsh(row, 'uptime')).rejects.toThrow(/pas encore vérifié/);
    const first = await testSsh(row.id);
    expect(first).toMatchObject({ ok: false });
    expect(first.hostKey).toMatch(/^SHA256:/);
    const trusted = await testSsh(row.id, true);
    expect(trusted).toMatchObject({ ok: true, trusted: true });
    const ready = (await getSsh(row.id))!;
    expect(await executeSsh(ready, 'uptime')).toMatchObject({ status: 'succeeded', exitCode: 0, stdout: ' 10:00 up 3 days\n' });
    expect(await executeSsh(ready, 'false')).toMatchObject({ status: 'failed', exitCode: 1, stderr: 'boom\n' });
    expect(await executeSsh(ready, 'sleep', { timeoutMs: 300 })).toMatchObject({ status: 'timeout', exitCode: null });
    const abort = new AbortController(); setTimeout(() => abort.abort(), 200);
    expect(await executeSsh(ready, 'sleep', { timeoutMs: 10_000, signal: abort.signal })).toMatchObject({ status: 'cancelled' });
  });

  it('mot de passe faux, mot de passe masqué dans la sortie, hôte injoignable', async () => {
    const bad = await saveSsh({ name: 'Mauvais', host: '127.0.0.1', port, username: 'robin', auth: 'password', password: 'wrong' });
    expect((await testSsh(bad.id, true)).error).toMatch(/Authentification refusée/);
    const good = await saveSsh({ name: 'Bon', host: '127.0.0.1', port, username: 'robin', auth: 'password', password: 'right-password' });
    await testSsh(good.id, true);
    const out = await executeSsh((await getSsh(good.id))!, 'echo-secret');
    expect(out.stdout).toBe('the pass is [secret] ok\n');
    expect(redact('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----', good)).toBe('[clé privée masquée]');
    const away = await saveSsh({ name: 'Loin', host: '127.0.0.1', port: 1, username: 'robin', auth: 'password', password: 'x1234567' });
    expect((await testSsh(away.id, true)).error).toMatch(/refusée par 127\.0\.0\.1:1|injoignable/);
  });

  it('une clé d’hôte qui change est refusée', async () => {
    const row = await saveSsh({ name: 'Change', host: '127.0.0.1', port, username: 'robin', auth: 'key', privateKey: userKey.private });
    await testSsh(row.id, true);
    server.close(); await start(secondHostKey.private);
    await db().update(schema.sshConnections).set({ port }).where(eq(schema.sshConnections.id, row.id));
    await expect(executeSsh((await getSsh(row.id))!, 'uptime')).rejects.toThrow(/La clé de l’hôte a changé/);
  });

  it('un Circle ne voit que ses machines ; « ask » attend la validation, qui revérifie l’accès', async () => {
    const ari = await createAgent({ name: 'Ari' }), other = await createAgent({ name: 'Autre' });
    const row = await saveSsh({ name: 'Box', host: '127.0.0.1', port, username: 'robin', auth: 'key', privateKey: userKey.private, agents: [ari.id] });
    await testSsh(row.id, true);
    const conv = await mainConversationId(ari.id);
    const ariTools = sshTools({ agent: ari, conversationId: conv, isMain: true, userTurn: true, depth: 0, tz: 'UTC' } as any) as any;
    const otherTools = sshTools({ agent: other, conversationId: await mainConversationId(other.id), isMain: true, userTurn: true, depth: 0, tz: 'UTC' } as any) as any;
    expect((await otherTools.connections_list.execute({}, {})).connections).toHaveLength(0);
    expect(await otherTools.ssh_execute.execute({ connection: 'Box', command: 'uptime' }, { toolCallId: 't0' })).toMatchObject({ ok: false, status: 'not_allowed' });
    const listed = (await ariTools.connections_list.execute({}, {})).connections;
    expect(listed.map((c: any) => c.name)).toContain('Box');
    expect(JSON.stringify(listed)).not.toMatch(/PRIVATE|secret/i);
    const pending = await ariTools.ssh_execute.execute({ connection: 'Box', command: 'uptime' }, { toolCallId: 't1' });
    expect(pending).toMatchObject({ status: 'pending_approval' });
    const approved = await resolveApproval(pending.approvalId, 'approve', { by: 'ui', notifyAgent: false });
    expect(approved.status).toBe('executed');
    expect(JSON.stringify(approved.result)).toContain('up 3 days');
    // Access removed before approval: refused at execution.
    const again = await ariTools.ssh_execute.execute({ connection: 'Box', command: 'uptime' }, { toolCallId: 't2' });
    await saveSsh({ id: row.id, agents: [] });
    const refused = await resolveApproval(again.approvalId, 'approve', { by: 'ui', notifyAgent: false });
    expect(refused.status).toBe('failed');
    expect(refused.error).toMatch(/plus accessible/);
  });
});
