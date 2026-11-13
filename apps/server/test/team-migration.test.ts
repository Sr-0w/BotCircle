import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { expect, it } from 'vitest';

it('ajoute le suivi des délégations à une base migrée par main sans perdre ses données', async () => {
  const migrationsFolder = fileURLToPath(new URL('../drizzle/', import.meta.url));
  const journal = JSON.parse(await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string; when: number }[];
  };
  const previous = journal.entries.filter(({ tag }) => tag !== '0016_team_handoffs');
  const mainFolder = await mkdtemp(join(tmpdir(), 'botcircle-team-migration-'));
  const client = new PGlite();
  try {
    await mkdir(join(mainFolder, 'meta'));
    await writeFile(join(mainFolder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: previous }));
    await Promise.all(previous.map(({ tag }) => copyFile(join(migrationsFolder, tag + '.sql'), join(mainFolder, tag + '.sql'))));
    const database = drizzle(client);
    await migrate(database, { migrationsFolder: mainFolder });
    await client.query("INSERT INTO settings (key, value) VALUES ('team-migration-probe', '12')");
    await migrate(database, { migrationsFolder });
    await migrate(database, { migrationsFolder });
    expect((await client.query('SELECT count(*)::int AS count FROM team_handoffs')).rows).toEqual([{ count: 0 }]);
    expect((await client.query("SELECT value FROM settings WHERE key = 'team-migration-probe'")).rows).toEqual([{ value: 12 }]);
    expect((await client.query('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations')).rows).toEqual([{ count: previous.length + 1 }]);
  } finally {
    await client.close();
    await rm(mainFolder, { recursive: true, force: true });
  }
});
