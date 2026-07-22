export const criteriaWriteLockKey = 424242;

export async function createCriteriaDraft(client, {
  checklistMarkdown,
  searchQueries,
  transcriptRules,
  source,
  parentVersionId = null,
  diffSummary,
  sourceJobId = null
}) {
  await client.query('select pg_advisory_xact_lock($1)', [criteriaWriteLockKey]);
  const result = await client.query(`
    insert into criteria_versions(
      version_number,checklist_markdown,search_queries,transcript_rules,status,
      source,parent_version_id,diff_summary,source_job_id
    )
    select coalesce(max(version_number),0)+1,$1,$2::jsonb,$3::jsonb,'draft',
      $4,coalesce($5::bigint,(select id from criteria_versions where status='active' limit 1)),$6,$7
    from criteria_versions
    returning *
  `, [
    checklistMarkdown,
    JSON.stringify(searchQueries || []),
    JSON.stringify(transcriptRules || {}),
    source,
    parentVersionId,
    diffSummary || null,
    sourceJobId
  ]);
  return result.rows[0];
}
