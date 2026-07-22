import crypto from 'node:crypto';
import { withTransaction } from '../db/pool.js';
import { enqueueJob } from '../db/repositories/jobs.js';

function proposalText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 5000) {
    throw Object.assign(new Error('Текст предложения должен содержать от 1 до 5000 символов'), { statusCode: 400 });
  }
  return text;
}

async function lockedDraft(client, proposalId) {
  const result = await client.query(`
    select p.*,a.lifecycle_status from outreach_proposals p
    join instagram_accounts a on a.id=p.account_id
    where p.id=$1 for update of p
  `, [proposalId]);
  const proposal = result.rows[0];
  if (!proposal) throw Object.assign(new Error('Черновик не найден'), { statusCode: 404 });
  if (proposal.status !== 'draft') throw Object.assign(new Error('Изменять можно только черновик'), { statusCode: 409 });
  return proposal;
}

export async function saveOutreachDraft(pool, proposalId, messageText, requestMeta = {}) {
  return withTransaction(pool, async (client) => {
    const proposal = await lockedDraft(client, proposalId);
    const message = proposalText(messageText);
    const updated = (await client.query(`
      update outreach_proposals set message_text=$2,updated_at=now() where id=$1 returning *
    `, [proposalId, message])).rows[0];
    await client.query(`
      insert into audit_events(action,entity_type,entity_id,old_values,new_values,request_ip,user_agent)
      values ('outreach_edit','outreach_proposal',$1,$2,$3,$4,$5)
    `, [proposalId, proposal, updated, requestMeta.ip || null, requestMeta.userAgent || null]);
    return updated;
  });
}

export async function decideOutreachDraft(pool, proposalId, status, requestMeta = {}, messageText) {
  if (!['approved', 'rejected'].includes(status)) throw new Error('Invalid outreach decision');
  return withTransaction(pool, async (client) => {
    const proposal = await lockedDraft(client, proposalId);
    if (proposal.lifecycle_status !== 'approved') {
      throw Object.assign(new Error('Блогер больше не одобрен'), { statusCode: 409 });
    }
    const timestamp = status === 'approved' ? 'approved_at' : 'rejected_at';
    const approvedMessage = status === 'approved' && messageText !== undefined
      ? proposalText(messageText)
      : proposal.message_text;
    const updated = (await client.query(`
      update outreach_proposals set status=$2,message_text=$3,${timestamp}=now(),updated_at=now() where id=$1 returning *
    `, [proposalId, status, approvedMessage])).rows[0];
    await client.query(`
      insert into audit_events(action,entity_type,entity_id,old_values,new_values,request_ip,user_agent)
      values ($1,'outreach_proposal',$2,$3,$4,$5,$6)
    `, [`outreach_${status}`, proposalId, proposal, updated, requestMeta.ip || null, requestMeta.userAgent || null]);
    return updated;
  });
}

export async function regenerateOutreachDraft(pool, config, accountId, requestMeta = {}) {
  return withTransaction(pool, async (client) => {
    const account = (await client.query('select * from instagram_accounts where id=$1 for update', [accountId])).rows[0];
    if (!account) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
    if (account.lifecycle_status !== 'approved') throw Object.assign(new Error('Блогер не одобрен'), { statusCode: 409 });
    await client.query(`update outreach_proposals set status='superseded',updated_at=now() where account_id=$1 and status='draft'`, [accountId]);
    const job = await enqueueJob(client, {
      accountId,
      jobType: 'draft_outreach',
      payload: { trigger: 'manual_regeneration' },
      dedupeKey: `account:${accountId}:outreach:${crypto.randomUUID()}`,
      maxAttempts: config.JOB_MAX_ATTEMPTS
    });
    await client.query(`
      insert into audit_events(action,entity_type,entity_id,new_values,request_ip,user_agent)
      values ('outreach_regenerate','instagram_account',$1,$2,$3,$4)
    `, [accountId, { jobId: job.id }, requestMeta.ip || null, requestMeta.userAgent || null]);
    return job;
  });
}
