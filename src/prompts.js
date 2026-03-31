import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';

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

  // Replace placeholders
  template = template
    .replace(/\{\{ticket_id\}\}/g, ticket.id)
    .replace(/\{\{ticket_title\}\}/g, ticket.title)
    .replace(/\{\{ticket_type\}\}/g, ticket.type || 'unknown')
    .replace(/\{\{ticket_json\}\}/g, JSON.stringify(ticket, null, 2))
    .replace(
      /\{\{pipeline_state\}\}/g,
      JSON.stringify(pipelineState, null, 2)
    )
    .replace(/\{\{backlog_path\}\}/g, config._resolved.backlog)
    .replace(/\{\{project_dir\}\}/g, config.project_dir)
    .replace(/\{\{pipeline_dir\}\}/g, config._resolved.pipelineDir);

  return template;
}

function getDefaultTemplate(stepName) {
  const templates = {
    plan: `You are working on ticket {{ticket_id}}: "{{ticket_title}}".

TICKET DATA:
{{ticket_json}}

YOUR TASK — PLAN STEP:
1. Read the ticket description and fix plan
2. Identify ALL files that need to change (source + tests + docs)
3. Read every file that will be modified
4. Trace ALL callers — grep for ALL call sites of every function that will change. Paste actual grep results.
5. Identify edge cases — what could go wrong?
6. Define test strategy — what tests to write, where

Write the pipeline JSON file at {{pipeline_dir}}/{{ticket_id}}.json with the plan step filled.
Set steps.plan.status = "done" with all artifacts:
- files_to_change: [{path, reason}] — non-empty
- callers_traced: [{function, callers}] — from actual grep results
- edge_cases: [] — non-empty
- test_strategy: "" — non-empty
- risk: "low|medium|high"

For feature tickets: check the New Feature Checklist — do we need model, repository, DAO, service, provider, widget, tests, backend?
For schema changes: flag if a numbered migration is needed.
If new dependencies are required: STOP and report — do not proceed.`,

    tests_red: `You are working on ticket {{ticket_id}}: "{{ticket_title}}".

PIPELINE STATE:
{{pipeline_state}}

YOUR TASK — TESTS RED STEP:
1. Check for existing tests that cover this behavior (grep test files)
2. If no existing test covers it: write new tests
   - For bugs: test the CLASS of bug, not just this instance
   - For UI changes: MUST include widget tests
3. Record test count BEFORE adding new tests
4. Run the tests — new/existing test must FAIL to confirm the bug exists
5. Capture the ACTUAL failure output (assertion error, compile error, stack trace)

Three valid outcomes:
- new_test_fails: you wrote a test, it fails → proceed
- existing_test_fails: existing test already fails → proceed
- existing_test_covers: existing test passes → STOP and investigate

Update pipeline JSON steps.tests_red with:
- outcome, test_files, test_names, tests_before, tests_after, failure_output, run_output_summary`,

    implement: `You are working on ticket {{ticket_id}}: "{{ticket_title}}".

PIPELINE STATE:
{{pipeline_state}}

YOUR TASK — IMPLEMENT STEP:
1. Make the minimal code change to fix/implement the ticket
2. Follow these rules strictly:
   - Trace callers before editing any function
   - One logical change at a time
   - Race condition audit on any async code
   - No silent catch blocks — every catch must log
   - if (!mounted) return; after every await before using ref/setState
   - Never add dependencies without flagging
3. After fixing, grep for the SAME PATTERN across the entire codebase — fix all matching locations or report them

Update pipeline JSON steps.implement with:
- files_changed: [{path, summary}] — every file from plan must be accounted for`,

    tests_green: `Run all tests and report results verbatim.

Commands to run:
export PATH="/home/toshe/tools/flutter/bin:$PATH"
cd {{project_dir}}/app && flutter test test/unit/
cd {{project_dir}}/app && flutter analyze

If any files_changed path starts with "backend/", also run:
cd {{project_dir}}/backend/functions && npm test

Report the FULL output (last 100 lines). Include ALL warnings and errors verbatim.
Do not filter, interpret, or decide what's important.

If something unexpected happens (crash, hang, infra failure), return full raw output with "INFRA FAILURE" flag.`,

    review: `You are reviewing the changes for ticket {{ticket_id}}: "{{ticket_title}}".

PIPELINE STATE:
{{pipeline_state}}

YOUR TASK — REVIEW STEP:
Run EVERY item in the validation checklist against the changed code:

1. Parameter completeness — all fields carried over in reconstructions?
2. Client/server consistency — with context, not blind matching
3. Test coverage for new code paths
4. State preservation on type/mode switches
5. Overdue/expiry edge cases
6. Silent error swallowing — every catch logs
7. Schedule system integrity
8. Capture pipeline consistency
9. Race condition patterns
10. Code duplication — grep for similar functions
11. Serialization round-trip integrity
12. Multiple paths to same feature — grep for all paths
13. UX touch target compliance (if UI changed)
14. Save-and-reload round-trip
15. Don't write stale data
16. Fix plan diff — every step in the fix plan has a corresponding file change

Also check cleanup:
- No // TODO, // FIXME, // HACK (unless in backlog)
- No debug print/debugPrint/console.log
- No commented-out code blocks
- Comments explain WHY not WHAT

Avoid false positives:
- Trace the full call chain before flagging
- Verify with a concrete scenario
- Check existing tests
- When in doubt: "needs review" not "bug"

Update pipeline JSON steps.review with:
- checklist_items_checked, findings[], findings_fixed`,

    root_cause: `Ticket {{ticket_id}} ("{{ticket_title}}") was a bug fix. Answer three questions:

PIPELINE STATE:
{{pipeline_state}}

1. WHY DID THIS HAPPEN?
   - What was the root cause? Go deeper than the symptom.

2. WHY DIDN'T WE CATCH IT?
   - Was there a test gap? A validation rule gap? A process gap?

3. WHAT RULE WOULD PREVENT THIS CLASS OF BUG?
   - Propose a specific, actionable rule for code_validation.md
   - Include: the pattern, an example, and how to detect it
   - Do NOT actually modify code_validation.md — just propose

Update pipeline JSON steps.root_cause with:
- why_happened, why_not_caught, proposed_rule`,

    docs_update: `Ticket {{ticket_id}} ("{{ticket_title}}") is complete.

PIPELINE STATE:
{{pipeline_state}}

Update the relevant documentation files based on what changed:
- If feature added/changed → update memory/SPEC.md
- If bug fixed → verify it's in memory/closed-bugs.json
- If architecture changed → update memory/ARCHITECTURE.md
- If data model changed → update memory/DATA_MODEL.md
- If flows changed → update memory/FLOWS.md
- If user-facing behaviour changed → check help_screen.dart
- Always → append to memory/build-log/{today}.md

Update pipeline JSON steps.docs_update with:
- files_updated: [{path, summary}]`,
  };

  return templates[stepName] || `Execute step "${stepName}" for ticket {{ticket_id}}.`;
}
