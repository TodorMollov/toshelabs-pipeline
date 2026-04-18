import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Which prior steps each step actually needs in its prompt.
 * Everything else is noise that inflates input tokens.
 */
const STEP_DEPENDENCIES = {
  plan: [],
  tests_red: ['plan'],
  implement: ['plan', 'tests_red'],
  tests_green: ['implement'],
  review: ['plan', 'implement'],
  root_cause: ['plan', 'implement', 'review'],
  docs_update: ['plan', 'implement', 'review', 'root_cause'],
};

/**
 * Build a trimmed pipeline state containing only the steps this step needs.
 */
function trimPipelineState(pipelineState, stepName) {
  const deps = STEP_DEPENDENCIES[stepName];
  if (!deps) return pipelineState; // unknown step — pass everything

  const trimmed = { ...pipelineState, steps: {} };
  for (const dep of deps) {
    if (pipelineState.steps[dep]) {
      trimmed.steps[dep] = pipelineState.steps[dep];
    }
  }
  return trimmed;
}

/**
 * Build the prompt for a given step, injecting ticket data and context.
 */
export async function buildPrompt(stepConfig, ticket, pipelineState, config) {
  // Try to load template file
  const templatePath = resolve(
    process.cwd(),
    stepConfig.prompt_template || `prompts/${stepConfig.name}.md`
  );

  let template = '';
  if (existsSync(templatePath)) {
    template = await readFile(templatePath, 'utf-8');
  } else {
    // Use built-in default
    template = getDefaultTemplate(stepConfig.name);
  }

  // Trim pipeline state to only include steps this step depends on
  const relevantState = trimPipelineState(pipelineState, stepConfig.name);

  // Plan step needs full ticket; other steps only need identity + description
  // (the plan output in pipeline_state has the distilled understanding)
  const ticketForPrompt = stepConfig.name === 'plan'
    ? ticket
    : { id: ticket.id, title: ticket.title, type: ticket.type, description: ticket.description };

  // Replace placeholders
  template = template
    .replace(/\{\{ticket_id\}\}/g, ticket.id)
    .replace(/\{\{ticket_title\}\}/g, ticket.title)
    .replace(/\{\{ticket_type\}\}/g, ticket.type || 'unknown')
    .replace(/\{\{ticket_json\}\}/g, JSON.stringify(ticketForPrompt))
    .replace(
      /\{\{pipeline_state\}\}/g,
      JSON.stringify(relevantState)
    )
    .replace(/\{\{backlog_path\}\}/g, config._resolved.backlog)
    .replace(/\{\{project_dir\}\}/g, config.project_dir)
    .replace(/\{\{pipeline_dir\}\}/g, config._resolved.pipelineDir);

  return template;
}

function getDefaultTemplate(stepName) {
  const EFFICIENCY_RULE = `
OUTPUT RULES — THIS IS A PIPELINE, NOT A CONVERSATION:
- Do the full investigation (read files, grep, trace callers) but do NOT narrate it.
- Your ONLY text output is code changes and the pipeline JSON update.
- No explanations, no commentary, no "Let me check...", no "I found that...".
- If you must reason, do it silently. Only output actions and results.`;

  const templates = {
    plan: `Ticket {{ticket_id}}: "{{ticket_title}}"
{{ticket_json}}
${EFFICIENCY_RULE}

PLAN STEP:
1. Read ticket description and fix plan
2. Identify ALL files that need to change (source + tests + docs)
3. Read every file that will be modified
4. Trace ALL callers — grep for call sites of every function that will change
5. Identify edge cases
6. Define test strategy

For features: check if we need model, repository, DAO, service, provider, widget, tests, backend.
For schema changes: flag if a numbered migration is needed.
New dependencies: STOP and report.

IMPORTANT: You MUST write the pipeline JSON file before your session ends.
Write {{pipeline_dir}}/{{ticket_id}}.json with steps.plan.status = "done" and ALL of these fields:
- files_to_change: [{path, reason, what_to_do}] — ONLY files that MUST change for the ticket to work. If a caller might be affected but the change is backward-compatible, do NOT list it. Verify: "will this file fail to compile or behave incorrectly without a change?" If no, exclude it. reason: WHY. what_to_do: SPECIFIC action.
- callers_traced: [{function, callers: ["file:line"]}] — just file:line refs, not grep output
- edge_cases: ["short description"] — one line each
- test_strategy: "one paragraph max"
- risk: "low|medium|high"

If you are running low on turns, STOP investigating and write the JSON with what you have.`,

    tests_red: `Ticket {{ticket_id}}: "{{ticket_title}}"
{{ticket_json}}
PIPELINE STATE: {{pipeline_state}}
${EFFICIENCY_RULE}

TESTS RED STEP:
1. Read plan from PIPELINE STATE
2. Grep for existing tests covering this behavior
3. If none: write new tests (bugs: test the CLASS; UI: widget tests)
4. Record test count BEFORE adding tests
5. Run tests — must FAIL
6. Run full suite BEFORE changes to capture baseline_failures

Three outcomes: new_test_fails | existing_test_fails | existing_test_covers (→ STOP)

Write {{pipeline_dir}}/{{ticket_id}}.json with steps.tests_red.status = "done":
- outcome, test_files, test_names, tests_before, tests_after
- failure_output: "one line per failing test — assertion message only, no stack traces"
- baseline_failures: [test names already failing before changes]
- criteria_to_test_map: [{criterion: "what the plan says must happen", test_name: "name of test that covers it"}] — one entry per deliverable/acceptance criterion from the plan. If a plan deliverable has no corresponding test, you MUST write one. Every files_to_change what_to_do must appear as a criterion.
If blocked: set status = "blocked" with reason.`,

    implement: `Ticket {{ticket_id}}: "{{ticket_title}}"
{{ticket_json}}
PIPELINE STATE: {{pipeline_state}}
${EFFICIENCY_RULE}

IMPLEMENT STEP:
1. Read plan and test results from PIPELINE STATE
2. If steps.implement.review_feedback exists — FIX EVERY ITEM FIRST. These are blocking.
   If steps.implement.explicit_fixes exists — follow them LITERALLY.
3. Minimal code change. Rules:
   - Trace callers before editing any function
   - Race condition audit on async code
   - No silent catch blocks — every catch must log
   - if (!mounted) return; after every await before setState
   - Never add dependencies without flagging
4. Grep for SAME PATTERN across codebase — fix all matching locations

Write {{pipeline_dir}}/{{ticket_id}}.json with steps.implement.status = "done":
- files_changed: [{path}] — every file you modified
- files_skipped: [{path, reason}] — for any file in plan.files_to_change that you did NOT modify, explain why (e.g. "backward-compatible, no change needed" or "deferred — not required for this ticket")
If blocked: set status = "blocked" with reason.`,

    tests_green: `Ticket {{ticket_id}}: "{{ticket_title}}"
PIPELINE STATE: {{pipeline_state}}

TESTS GREEN — run tests and write JSON. Nothing else.

1. cd {{project_dir}}/app && flutter test test/unit/
2. cd {{project_dir}}/app && flutter analyze
3. If backend files changed: cd {{project_dir}}/backend/functions && npm test
4. Write {{pipeline_dir}}/{{ticket_id}}.json immediately:

steps.tests_green = {
  "status": "done",
  "unit_tests": {"passed": N, "failed": N},
  "analyzer_errors": 0,
  "failed_tests": ["test name"],
  "baseline_failures": [copy from steps.tests_red.baseline_failures],
  "new_failures": <failures NOT in baseline>
}

new_failures > 0 → status = "failed".`,

    review: `Ticket {{ticket_id}}: "{{ticket_title}}"
{{ticket_json}}
PIPELINE STATE: {{pipeline_state}}
${EFFICIENCY_RULE}

REVIEW STEP — Do the full investigation silently. Output ONLY findings and JSON.

WORK (do all of this, but don't narrate):
1. Read every file in steps.implement.files_changed
2. If steps.implement.files_skipped exists — verify EVERY skip. For each skipped file:
   a. Read the skipped file.
   b. Look at the plan's what_to_do for that file — extract the key nouns/verbs (e.g. "showDialog", "create.*entry", the widget class name).
   c. Grep the skipped file for those terms. If the functionality is NOT present, the skip is false — add a BLOCKING finding: "file_path: plan required [what_to_do] but file has no matching code."
   d. A skip reason of "Already implemented" is only valid if the grep proves the code exists.
3. Run the full 16-point checklist: parameter completeness, client/server consistency, test coverage, state preservation, error handling, race conditions, code duplication, serialization, multiple paths, UX targets, save-reload, plan coverage
3. Check cleanup: no TODO/FIXME/HACK, no debug prints, no commented-out code
4. Trace full call chain before flagging anything
5. Fix any findings you can fix directly (edit the file)

OUTPUT — only this, nothing else:
Write {{pipeline_dir}}/{{ticket_id}}.json with steps.review:
- status: "done" (all fixed or no findings) | "blocked" (unfixable findings)
- checklist_items_checked: number
- findings: [{file, line, severity, issue, fix}] — issue is ONE sentence, fix is ONE sentence
- findings_fixed: <number you fixed>

Severity: "blocking" = breaks at runtime. "medium" = wrong behavior. "low" = style/cleanup.
If 0 findings: status = "done", findings = [], findings_fixed = 0.`,

    root_cause: `Ticket {{ticket_id}} ("{{ticket_title}}") — bug fix.
PIPELINE STATE: {{pipeline_state}}
${EFFICIENCY_RULE}

ROOT CAUSE — one sentence per field, no prose.

Write {{pipeline_dir}}/{{ticket_id}}.json with steps.root_cause.status = "done":
- why_happened: "one sentence"
- why_not_caught: "one sentence"
- proposed_rule: "one sentence — the pattern, how to detect it"`,

    docs_update: `Ticket {{ticket_id}} ("{{ticket_title}}") is complete.
{{ticket_json}}
PIPELINE STATE: {{pipeline_state}}
${EFFICIENCY_RULE}

DOCS UPDATE — edit files directly, then write JSON.

ALREADY DONE (do NOT touch these — handled by the pipeline automatically):
- memory/closed-bugs.json — already updated
- memory/build-log/{today}.md — already appended

Check and update if applicable (skip silently if N/A):
1. memory/SPEC.md — new UI conventions or behaviors
2. memory/ARCHITECTURE.md — if architecture changed
3. memory/DATA_MODEL.md — if data model changed
4. memory/FLOWS.md — if user flows changed
5. help_screen.dart — if user-facing behavior changed
6. Grep for stale hints/tooltips referencing old behavior
7. memory/code_validation.md — if new coding rule from root_cause

Update ticket status in {{backlog_path}}: set status = "done".

Write {{pipeline_dir}}/{{ticket_id}}.json with steps.docs_update.status = "done":
- files_updated: [{path}] — path only
- backlog_updated: true`,
  };

  return templates[stepName] || `Execute step "${stepName}" for ticket {{ticket_id}}.`;
}
