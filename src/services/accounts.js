import { withTransaction } from '../db/pool.js';
import { upsertAccount } from '../db/repositories/accounts.js';
import { assertTransition } from '../domain/accounts.js';
import { startPipeline } from './pipelines.js';

export async function addManualAccount(pool, config, input, sourceNote = null) {
  const account = await withTransaction(pool, (client) => upsertAccount(client, {
    input, sourceType: 'manual', sourceNote
  }));
  let pipeline = null;
  if (account.inserted) {
    pipeline = await startPipeline(pool, config, {
      accountId: account.id, runType: 'candidate_enrichment', reelsLimit: config.REELS_DEFAULT_LIMIT
    });
  }
  return { account, pipeline };
}

async function transition(pool, { accountId, to, reason, requestMeta = {} }) {
  return withTransaction(pool, async (client) => {
    const result = await client.query('select * from instagram_accounts where id=$1 for update', [accountId]);
    const account = result.rows[0];
    if (!account) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
    assertTransition(account.lifecycle_status, to);
    if (to === 'approved' && account.lifecycle_status === 'candidate') {
      const evaluation = await client.query('select 1 from evaluations where account_id=$1 limit 1', [accountId]);
      if (!evaluation.rowCount) throw Object.assign(new Error('A valid LLM evaluation is required'), { statusCode: 409 });
    }
    const timestampColumn = { approved: 'approved_at', rejected: 'rejected_at', archived: 'archived_at' }[to];
    const updates = [`lifecycle_status=$2`, `updated_at=now()`];
    if (timestampColumn) updates.push(`${timestampColumn}=now()`);
    if (to === 'approved' && account.lifecycle_status === 'archived') updates.push('archived_at=null');
    if (to === 'rejected') updates.push('rejection_reason=$3');
    const parameters = to === 'rejected' ? [accountId, to, reason || null] : [accountId, to];
    const updated = await client.query(
      `update instagram_accounts set ${updates.join(', ')} where id=$1 returning *`,
      parameters
    );
    if (to === 'rejected' || to === 'archived') {
      await client.query(`
        update jobs set status='cancelled', finished_at=now(), updated_at=now()
        where account_id=$1 and status in ('pending','retry_wait')
      `, [accountId]);
    }
    await client.query(`
      insert into audit_events(action, entity_type, entity_id, old_values, new_values, reason, request_ip, user_agent)
      values ($1,'instagram_account',$2,$3,$4,$5,$6,$7)
    `, [to, accountId, account, updated.rows[0], reason || null, requestMeta.ip || null, requestMeta.userAgent || null]);
    return updated.rows[0];
  });
}

export const approveAccount = (pool, accountId, requestMeta) => transition(pool, { accountId, to: 'approved', requestMeta });
export const rejectAccount = (pool, accountId, reason, requestMeta) => transition(pool, { accountId, to: 'rejected', reason, requestMeta });
export const archiveAccount = (pool, accountId, reason, requestMeta) => transition(pool, { accountId, to: 'archived', reason, requestMeta });
export const restoreAccount = (pool, accountId, requestMeta) => transition(pool, { accountId, to: 'approved', requestMeta });
