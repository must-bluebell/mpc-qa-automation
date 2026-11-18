import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { target } from '../config/target'
import { activityFixtureContainer } from '../pipeline/lib/activity-target.mjs'

/** Notification UI prerequisites only: no successful transaction, reward, or chain evidence is injected. */
export async function storedActivity(wallet: string, mode: 'pending' | 'failed') {
  const environments = JSON.parse(readFileSync(new URL('../pipeline/config/environments.json', import.meta.url), 'utf8'))
  const container = activityFixtureContainer(process.env, environments, target().baseUrl)
  if (!/^0x[0-9a-f]{40}$/i.test(wallet)) throw new Error('Invalid Activity fixture wallet')
  const run = (query: string) => new Promise<string>((resolve, reject) => {
    const child = execFile('docker', ['exec', '-i', '-w', '/app', container, 'node', '--input-type=module', '-'],
      { timeout: 30_000 }, (error, stdout) => error ? reject(new Error('Local Activity fixture SQL failed')) : resolve(stdout.trim()))
    child.stdin!.end(`
      import {neon, neonConfig} from '@neondatabase/serverless';
      import {assertBootstrapDb} from './docker/bootstrap-db.mjs';
      assertBootstrapDb();
      neonConfig.fetchEndpoint=process.env.NEON_FETCH_ENDPOINT;
      const sql=neon(process.env.DATABASE_URL);
      const wallet=${JSON.stringify(wallet.toLowerCase())};
      ${query}
    `)
  })
  const id = await run(`
    const [row]=await sql\`INSERT INTO transaction_activities
      (wallet,area,action_kind,activity_kind,operation_key,submission_mode,expires_at,visible_at,finished_at,outcome)
      VALUES (\${wallet},'quests','claim','waitlist_claim',\${'web-ui:'+crypto.randomUUID()},'direct',
        now()+interval '10 minutes',now(),\${${mode === 'failed' ? 'new Date()' : 'null'}},\${${mode === 'failed' ? "'failed'" : 'null'}})
      RETURNING id\`;
    console.log(String(row.id));
  `)
  if (!/^\d+$/.test(id)) throw new Error('Local Activity fixture returned no ID')
  return { id, cleanup: () => run(`await sql\`DELETE FROM transaction_activities WHERE id=\${${JSON.stringify(id)}}::bigint AND wallet=\${wallet}\`;`) }
}
