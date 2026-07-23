import { canonicalInstagramUrl, normalizeInstagramUsername } from '../../domain/accounts.js';

export async function upsertAccount(client, { input, sourceType, sourceNote = null, discoveryRunId = null, searchQuery = null }) {
  const username = normalizeInstagramUsername(input);
  const instagramUrl = canonicalInstagramUrl(username);
  const result = await client.query(`
    insert into instagram_accounts(username, instagram_url, source_type, source_note)
    values ($1, $2, $3, $4)
    on conflict (username) do update set updated_at = instagram_accounts.updated_at
    returning *, (xmax = 0) as inserted
  `, [username, instagramUrl, sourceType, sourceNote]);
  const account = result.rows[0];
  await client.query(`
    insert into account_sources(account_id, source_type, discovery_run_id, search_query, source_note)
    values ($1, $2, $3, $4, $5)
    on conflict (account_id, discovery_run_id, search_query)
      where discovery_run_id is not null do nothing
  `, [account.id, sourceType, discoveryRunId, searchQuery, sourceNote]);
  return account;
}

export async function getAccount(client, id) {
  const result = await client.query(`
    select a.*, p.display_name, p.bio, p.avatar_url, p.followers, p.following,
           p.posts_count, p.verified, p.is_private, p.profile_status, p.fetched_at as profile_fetched_at,
           e.recommendation, e.confidence, e.positive_signals, e.negative_signals,
           e.explanation, e.created_at as evaluated_at,
           coalesce(rc.reels_count, 0)::int as reels_count,
           coalesce(rc.useful_reels_count, 0)::int as useful_reels_count
    from instagram_accounts a
    left join account_profiles p on p.account_id = a.id
    left join lateral (
      select * from evaluations where account_id = a.id order by created_at desc limit 1
    ) e on true
    left join lateral (
      select count(*) as reels_count,
             count(*) filter (where transcript_quality = 'useful') as useful_reels_count
      from reels where account_id = a.id
    ) rc on true
    where a.id = $1
  `, [id]);
  return result.rows[0] || null;
}

export async function listAccounts(client, { statuses, search, prioritizeUncertain = false, limit = 24, offset = 0 }) {
  const params = [statuses, limit, offset];
  let searchSql = '';
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    searchSql = `and (lower(a.username) like $4 or lower(coalesce(p.display_name, '')) like $4)`;
  }
  const result = await client.query(`
    select a.*, p.display_name, p.bio, p.avatar_url, p.followers, p.profile_status,
           p.fetched_at as profile_fetched_at,
           e.recommendation, e.confidence, e.explanation, e.created_at as evaluated_at,
           coalesce(rc.reels_count, 0)::int as reels_count,
           coalesce(rc.useful_reels_count, 0)::int as useful_reels_count,
           pr.status as pipeline_status,
           op.status as outreach_status
    from instagram_accounts a
    left join account_profiles p on p.account_id = a.id
    left join lateral (select * from evaluations where account_id = a.id order by created_at desc limit 1) e on true
    left join lateral (
      select count(*) as reels_count,
             count(*) filter (where transcript_quality = 'useful') as useful_reels_count
      from reels where account_id = a.id
    ) rc on true
    left join lateral (
      select status from pipeline_runs where account_id = a.id order by created_at desc limit 1
    ) pr on true
    left join lateral (
      select status from outreach_proposals where account_id = a.id order by created_at desc limit 1
    ) op on true
    where a.lifecycle_status = any($1::text[]) ${searchSql}
    order by
      ${prioritizeUncertain ? `case when e.recommendation='needs_manual_review' then 0 when e.confidence is not null then 1 else 2 end,
      case when e.confidence is not null then abs(e.confidence - 50) else 101 end,` : ''}
      a.updated_at desc, a.id desc
    limit $2 offset $3
  `, params);
  return result.rows;
}

export async function listAccountReels(client, accountId, limit = 20) {
  const result = await client.query(`
    select * from reels where account_id = $1
    order by published_at desc nulls last, id desc limit $2
  `, [accountId, limit]);
  return result.rows;
}

export async function listReels(client, { search, quality, limit = 24, offset = 0 }) {
  const params = [limit, offset];
  const where = [];
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    where.push(`lower(a.username) like $${params.length}`);
  }
  if (quality) {
    params.push(quality);
    where.push(`r.transcript_quality = $${params.length}`);
  }
  const result = await client.query(`
    select r.*, a.username, p.avatar_url
    from reels r
    join instagram_accounts a on a.id = r.account_id
    left join account_profiles p on p.account_id = a.id
    ${where.length ? `where ${where.join(' and ')}` : ''}
    order by r.published_at desc nulls last, r.id desc
    limit $1 offset $2
  `, params);
  return result.rows;
}
