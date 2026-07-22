# LLM-driven search automation

The worker runs a lightweight scheduler every five minutes. It does not call providers directly; it only creates ordinary deduplicated jobs, so the existing queue, retry, lease and audit behavior remains authoritative.

## Criteria feedback loop

Only initial human decisions from `candidate` to `approved` or `rejected` count as feedback. Archive/restore actions do not count. By default, ten new decisions enqueue a low-priority `propose_criteria` job. If there is at least one new decision, the maximum refresh interval is 24 hours.

The LLM receives information-complete approved and rejected examples, rejection reasons and the current criteria. It returns:

- checklist Markdown;
- distinct discovery queries;
- ideal blogger profile;
- required, preferred and exclusion signals;
- weighted scoring criteria;
- transcript classification rules;
- an explanation of the changes.

The resulting version is always a `draft`. It never becomes active without an administrator pressing **Activate**. Candidate evaluation receives both the active checklist and its structured selection model.

## Automatic discovery

Automatic discovery reads only queries from the active criteria version. Defaults are enabled with a global budget of 20 accounts per UTC day and at most five accounts per query. Queries are trimmed and deduplicated case-insensitively. Automatic jobs use priority `-10`; manual jobs remain ahead of them.

Existing usernames are upserted without changing their lifecycle, so previously approved, rejected or archived accounts cannot return as new candidates. Per-day job keys and the existing account/source constraints make scheduler restarts idempotent.

Every discovered account that is still a candidate and has never entered a processing pipeline is automatically queued for profile and reels enrichment. The normal pipeline then fetches transcripts, classifies useful content and runs the LLM evaluation. Rediscovery does not restart an existing or completed pipeline, and accounts in approved, rejected or archived states are never queued as candidates.

## Settings

The **Settings → Автоматизация поиска** form controls both switches, the decision threshold, maximum refresh interval and discovery budgets. Saving creates a criteria draft; activation is explicit. The panel also shows today's scheduled discovery budget and pending automatic criteria jobs.

Existing criteria versions without an embedded `criteriaAutomation` block use the release defaults. Settings are stored in `criteria_versions.transcript_rules.criteriaAutomation`, so schema version 2 remains unchanged.
