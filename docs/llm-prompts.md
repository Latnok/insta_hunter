# Editable LLM prompts

The administrator can view and edit the two business prompts on the **Settings** page:

- **Анализ блогера** controls candidate evaluation.
- **Написание оффера** controls the personalized barter proposal.

The application appends the current criteria and account data to these instructions. The structured-output requirement is enforced separately in code and cannot be removed through the editor.

## Versioning and activation

Saving the editor does not change worker behavior immediately. It creates a new `draft` in `criteria_versions`, preserving the active checklist, search queries and transcript rules and replacing only `transcript_rules.llmPrompts`. The administrator can inspect the prompts stored in each version and then explicitly **Activate** or **Reject** the draft.

Workers always read prompts from the active criteria version. Criteria created before this feature have no stored `llmPrompts`, so the application uses the release defaults. LLM-generated criteria drafts inherit the prompts from the active version instead of overwriting them.

Both fields are required, trimmed on save and limited to 12,000 characters. The route is authenticated and CSRF-protected; EJS escapes stored prompt text when it is rendered.
