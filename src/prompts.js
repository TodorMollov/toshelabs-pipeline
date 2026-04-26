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

// Extract project-relative file paths from prose (description + fix_plan).
// Tickets reference paths like `app/lib/foo.dart`, `backend/.../bar.ts`, or
// `memory/SPEC.md`, sometimes with a line range suffix `:412-491` and sometimes
// with multi-range syntax `:87-160, 870-883`. We pre-load these into the plan
// prompt so the worker never has to spend a Read turn (or three) on files it
// could have started with already in context.
//
// Two passes:
//   1) Match paths with at least one slash + range/multi-range suffix.
//   2) For paths recorded in pass 1, also match bare-filename references
//      (e.g. fix_plan says "_VehicleInput class (onboarding_screen.dart:755)")
//      and add their line ranges to the same path entry.
//
// Returns Map<fullPath, [{start,end},...]> — empty array means "whole file".
const FULL_PATH_REGEX = /\b((?:[\w@-]+\/)+[\w@.-]+\.(?:dart|ts|tsx|js|jsx|md|yaml|yml|json|py|html|css|sh))((?::\d+(?:-\d+)?(?:\s*,\s*\d+(?:-\d+)?)*)?)/g;
function parseRangeList(suffix) {
  // suffix is e.g. ":87-160, 870-883" or ":471" or ""
  if (!suffix) return [];
  const out = [];
  for (const part of suffix.replace(/^:/, '').split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : start;
    out.push({ start, end });
  }
  return out;
}
function extractFilePaths(text) {
  const found = new Map();
  if (!text) return found;

  // Pass 1: full paths with optional multi-range suffix.
  let m;
  while ((m = FULL_PATH_REGEX.exec(text)) !== null) {
    const path = m[1];
    if (!found.has(path)) found.set(path, []);
    for (const r of parseRangeList(m[2])) found.get(path).push(r);
  }

  // Pass 2: bare-filename references that match a path already seen — let
  // fix_plan items like "(onboarding_screen.dart:755)" backfill ranges onto
  // the full app/lib/.../onboarding_screen.dart entry from pass 1.
  for (const fullPath of [...found.keys()]) {
    const basename = fullPath.split('/').pop();
    const escaped = basename.replace(/[.+]/g, '\\$&');
    const bareRegex = new RegExp(`(?<![\\w/-])${escaped}((?::\\d+(?:-\\d+)?(?:\\s*,\\s*\\d+(?:-\\d+)?)*)?)`, 'g');
    let bm;
    while ((bm = bareRegex.exec(text)) !== null) {
      // Skip the match that's part of the full path itself.
      const startIdx = bm.index;
      const before = text.slice(Math.max(0, startIdx - fullPath.length), startIdx);
      if (before.endsWith(fullPath.slice(0, -basename.length))) continue;
      for (const r of parseRangeList(bm[1])) found.get(fullPath).push(r);
    }
  }

  return found;
}

// Load each referenced file (or just its requested line range) and render
// as <file> blocks for direct injection into the plan prompt.
//
// Capped at MAX_FILES files total and MAX_BYTES_PER_FILE per file so a long
// description with 30 path mentions doesn't blow the prompt budget. Larger
// files get truncated with an explicit marker, so the worker knows to Read
// the rest if needed (the common case is `:start-end` ranges, which fit).
async function loadReferencedFiles(text, projectDir) {
  const MAX_FILES = 8;
  const MAX_BYTES_PER_FILE = 20_000;
  const refs = extractFilePaths(text);
  const blocks = [];
  let count = 0;
  for (const [relPath, ranges] of refs) {
    if (count >= MAX_FILES) break;
    const abs = resolve(projectDir, relPath);
    if (!existsSync(abs)) continue;
    let content;
    try { content = await readFile(abs, 'utf-8'); }
    catch { continue; }

    // If the ticket asked for specific line ranges, render only those — saves
    // tokens and matches what the worker would have read anyway.
    if (ranges.length > 0) {
      const lines = content.split('\n');
      for (const { start, end } of ranges) {
        const slice = lines.slice(Math.max(0, start - 1), end || start).join('\n');
        const truncated = slice.length > MAX_BYTES_PER_FILE
          ? slice.slice(0, MAX_BYTES_PER_FILE) + `\n… [truncated; original ${slice.length}B]`
          : slice;
        blocks.push(`<file path="${relPath}" lines="${start}-${end || start}">\n${truncated}\n</file>`);
      }
    } else {
      const truncated = content.length > MAX_BYTES_PER_FILE
        ? content.slice(0, MAX_BYTES_PER_FILE) + `\n… [truncated; original ${content.length}B]`
        : content;
      blocks.push(`<file path="${relPath}">\n${truncated}\n</file>`);
    }
    count++;
  }
  if (blocks.length === 0) return '';
  return `\nFILES REFERENCED IN THIS TICKET (pre-loaded — do NOT Read these again unless you need a different section):\n\n${blocks.join('\n\n')}\n`;
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

  // Plan-step only: pre-load files mentioned in the ticket description and
  // fix_plan. Saves the worker the 3-10 Read turns it would otherwise spend
  // re-fetching the same paths the human session already enumerated.
  let referencedFiles = '';
  if (stepConfig.name === 'plan') {
    const fixPlanText = Array.isArray(ticket.fix_plan) ? ticket.fix_plan.join('\n') : '';
    referencedFiles = await loadReferencedFiles(
      `${ticket.description || ''}\n${fixPlanText}`,
      config.project_dir,
    );
  }

  // Replace placeholders
  template = template
    .replace(/\{\{ticket_id\}\}/g, ticket.id)
    .replace(/\{\{ticket_title\}\}/g, ticket.title)
    .replace(/\{\{ticket_type\}\}/g, ticket.type || 'unknown')
    .replace(/\{\{ticket_json\}\}/g, JSON.stringify(ticketForPrompt))
    .replace(/\{\{referenced_files\}\}/g, referencedFiles)
    .replace(
      /\{\{pipeline_state\}\}/g,
      JSON.stringify(relevantState)
    )
    .replace(/\{\{project_dir\}\}/g, config.project_dir)
    .replace(/\{\{pipeline_dir\}\}/g, config._resolved.pipelineDir)
    .replace(/\{\{tech_stack_hints\}\}/g, config.project_profile?.tech_stack_hints || 'use the project conventions')
    .replace(/\{\{test_commands\}\}/g, renderTestCommands(config))
    .replace(/\{\{docs_check_files\}\}/g, (config.project_profile?.docs_check_files || []).map((f, i) => `${i+1}. ${f}`).join('\n') || '(none configured)');

  return template;
}

function renderTestCommands(config) {
  const tc = config.project_profile?.test_commands;
  if (!tc) return '(no test commands configured — run tests via your project conventions)';
  const lines = [];
  const emit = (spec, note = '') => {
    const cwd = spec.cwd ? `cd ${config.project_dir}/${spec.cwd} && ` : '';
    lines.push(`- ${cwd}${spec.cmd}${note}`);
  };
  if (tc.unit) emit(tc.unit);
  if (tc.analyzer) emit(tc.analyzer);
  for (const [name, spec] of Object.entries(tc.extras || {})) {
    const note = spec.trigger_file_prefix ? ` (only if implement touched ${spec.trigger_file_prefix})` : '';
    emit(spec, note);
  }
  return lines.length ? lines.join('\n') : '(no test commands configured)';
}

function getDefaultTemplate(stepName) {
  const EFFICIENCY_RULE = `
========================================================
CRITICAL RULE — PARALLEL TOOL CALLS (read this first):
========================================================
Each LLM round-trip costs ~$0.30-0.50. To minimise cost, EVERY response that needs more than one independent tool call MUST emit them as parallel tool_use blocks in a SINGLE response.

CORRECT (one round-trip, three reads):
  <response>
    <tool_use name="Read" input='{"file_path":"a.dart"}'/>
    <tool_use name="Read" input='{"file_path":"b.dart"}'/>
    <tool_use name="Grep" input='{"pattern":"foo"}'/>
  </response>

WRONG (three round-trips, three reads):
  <response><tool_use name="Read" input='{"file_path":"a.dart"}'/></response>
  ... wait for result ...
  <response><tool_use name="Read" input='{"file_path":"b.dart"}'/></response>
  ... wait for result ...
  <response><tool_use name="Grep" input='{"pattern":"foo"}'/></response>

The ONLY exception is sequentially-dependent calls (e.g. Read X to find a path mentioned inside, then Read that path). If you can think of the calls as independent — fire them in parallel.

A single 8-tool-call investigation should fit in 2-3 round-trips, not 8.

========================================================
OUTPUT RULES — THIS IS A PIPELINE, NOT A CONVERSATION:
========================================================
- Do the full investigation (read files, grep, trace callers) but do NOT narrate it.
- Your ONLY text output is code changes and the pipeline JSON update.
- No explanations, no commentary, no "Let me check...", no "I found that...".
- If you must reason, do it silently. Only output actions and results.

TOKEN DISCIPLINE — DO NOT RE-READ:
- Once you Read a file in this session, the content stays in your context. Refer back to it; do NOT Read it again. If you need a specific section, quote the line range from your earlier read instead of re-reading.
- The same applies to test output files (/tmp/test-results.txt, etc.) and Grep results.
- Re-reading the same file twice in one step is the #1 cause of max_turns exhaustion (T-359 plan re-read parse-input.test.ts 3× → step thrashed and rolled back).

TOOL USE — GIT:
- The pipeline owns commit and rollback. Edit files; do not touch git state — git mutations from inside a step corrupt the pipeline's commit/rollback boundary.
- Allowed (inspection): \`git log\`, \`diff\`, \`status\`, \`show\`, \`blame\`, \`grep\`, \`rev-parse\`, \`ls-files\`, \`reflog\`.
- Forbidden: \`add\`, \`commit\`, \`reset\`, \`checkout\`, \`restore\`, \`switch\`, \`merge\`, \`rebase\`, \`cherry-pick\`, \`revert\`, \`stash\`, \`push\`, \`pull\`, \`fetch\`, \`clean\`, \`rm\`, \`mv\`, \`tag\`, \`notes\`, \`remote\`, \`config\`, \`worktree\`.`;

  const templates = {
    plan: `Ticket {{ticket_id}}: "{{ticket_title}}"
{{ticket_json}}
{{referenced_files}}
${EFFICIENCY_RULE}

PLAN STEP:
1. Read ticket description and fix_plan. **If fix_plan lists file paths and what-to-do bullets, that IS your starting point** — copy those into files_to_change and validate, do NOT re-derive from scratch.
2. Open each file in fix_plan ONCE to confirm the path/lines are accurate and the change is feasible. If a file is missing from fix_plan but clearly needs to change (e.g. test file for a new behavior), add it.
3. Trace callers ONLY for functions whose signature or behavior changes in a non-backward-compatible way. Pure additions (new fields, new logger calls, new tests) do NOT need callers traced — record them as "no_callers_needed: backward-compatible addition" in callers_traced.
4. Identify edge cases — one line each, max 5.
5. test_strategy is **one paragraph, high-level** — "unit tests on the parser, one widget test for the X path". Do NOT investigate test infrastructure (mock patterns, fixture loaders) at this step — that's tests_red's job.

For features: {{tech_stack_hints}}
For schema changes: flag if a numbered migration is needed.

DEPENDENCY DISCIPLINE (critical — this has broken past tickets):
If any file you plan to write will import a package (Dart: \`package:foo/…\`; TS/JS: \`import 'bar'\` or \`require('bar')\`; etc.) that is NOT already declared in the project's manifest (pubspec.yaml / package.json / etc.), you MUST add that manifest file to files_to_change with an explicit what_to_do describing the exact dep+version to add. A missing dep add will cause load-time compile failures that self-heal cannot fix. Check manifests before finalising the plan.

IMPORTANT: You MUST write the pipeline JSON file before your session ends.
Write {{pipeline_dir}}/{{ticket_id}}.json with steps.plan.status = "done" and ALL of these fields:
- files_to_change: [{path, reason, what_to_do}] — ONLY files that MUST change for the ticket to work. If a caller might be affected but the change is backward-compatible, do NOT list it. Verify: "will this file fail to compile or behave incorrectly without a change?" If no, exclude it. reason: WHY. what_to_do: SPECIFIC action. If the action is pure plumbing (field passing, data addition, constructor shape, import reorg) — something that will be covered transitively by behavioural tests rather than a dedicated test case — prefix the what_to_do with "[no-test]". tests_red will skip those bullets from coverage checks. Use sparingly; behavioural additions always need dedicated tests.
- SCOPE GATE: if files_to_change has more than 15 paths OR you find yourself writing more than 20 distinct what_to_do bullets, STOP. One implement step cannot reliably carry that much — it will hit max_turns and the ticket will be rolled back. Set status = "needs_split" with a suggested_sub_tickets: [{title, scope}] array of 2–4 sub-tickets covering the work, and STOP writing the plan.
- callers_traced: [{function, callers: ["file:line"]}] — just file:line refs, not grep output
- edge_cases: ["short description"] — one line each
- test_strategy: "one paragraph max"
- TEST-SHAPE BUDGET: prefer cheap tests. Pure-function unit tests on the smallest testable logic (a label→mode mapper, a date-window calculator, a status guard). Avoid widget tests with live data streams (Drift/StreamProvider/StreamBuilder) — they take 30-60s per pumpAndSettle and will blow the implement step's wall-clock budget. If the bug is genuinely a UI routing/rendering concern, use one widget test with a seeded in-memory DB + explicit pump() sequences, not pumpAndSettle. If the plan's test_strategy authorizes ≥3 widget tests, STOP — split out the mapping logic, unit-test that, add at most one integration smoke test.
- risk: "low|medium|high"

If you are running low on turns, STOP investigating and write the JSON with what you have.`,

    tests_red: `Ticket {{ticket_id}}: "{{ticket_title}}"
{{ticket_json}}
PIPELINE STATE: {{pipeline_state}}
${EFFICIENCY_RULE}

TESTS RED STEP:
1. Read plan from PIPELINE STATE
2. Grep for existing tests covering this behavior
3. If none: write new tests (bugs: test the CLASS; UI: matching surface test)
4. Record test count BEFORE adding tests
5. Run tests — must FAIL
6. Run full suite BEFORE changes to capture baseline_failures

ITERATION LIMIT: if you have edited the same test file 3 times and tests still don't fail in the expected way (or fail to compile), STOP and set status = "blocked" with a clear reason. Do NOT keep iterating — that's how BUG-250 burnt 25 turns on widget-test finder fights and rolled back.

Three outcomes: new_test_fails | existing_test_fails | existing_test_covers (→ STOP)

Write {{pipeline_dir}}/{{ticket_id}}.json with steps.tests_red.status = "done":
- outcome, test_files, test_names, tests_before, tests_after
- failure_output: "one line per failing test — assertion message only, no stack traces"
- baseline_failures: [test names already failing before changes]
- criteria_to_test_map: [{criterion: "what the plan says must happen", test_name: "name of test that covers it"}] — one entry per BEHAVIOURAL deliverable from the plan. Plan bullets prefixed with "[no-test]" are plumbing and SHOULD NOT appear here — they're covered transitively. Every other files_to_change what_to_do must appear as a criterion.
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

Test commands (run in order):
{{test_commands}}

Then write {{pipeline_dir}}/{{ticket_id}}.json immediately:

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
   b. Look at the plan's what_to_do for that file — extract the key nouns/verbs (e.g. function/class names, behaviors).
   c. Grep the skipped file for those terms. If the functionality is NOT present, the skip is false — add a BLOCKING finding: "file_path: plan required [what_to_do] but file has no matching code."
   d. A skip reason of "Already implemented" is only valid if the grep proves the code exists.
3. Run the full 16-point checklist: parameter completeness, client/server consistency, test coverage, state preservation, error handling, race conditions, code duplication, serialization, multiple paths, UX targets, save-reload, plan coverage
3. Check cleanup: no TODO/FIXME/HACK, no debug prints, no commented-out code
4. Trace full call chain before flagging anything
5. Fix any findings you can fix directly (edit the file)

OUTPUT — only this, nothing else:
Write {{pipeline_dir}}/{{ticket_id}}.json with steps.review:
- status: "done" (no findings, or you fixed all of them) | "blocked" (unfixable findings — name them)
- checklist_items_checked: number — MUST always be >0 (how many checklist items you actually evaluated). If you checked anything at all, this is not 0.
- findings: [{file, line, severity, issue, fix}] — issue is ONE sentence, fix is ONE sentence
- findings_fixed: if findings exist, one of:
    • true — you fixed all of them in this session (preferred when the fix is small)
    • "deferred" — findings are real but belong to a later cycle / different ticket; next implement pass will pick them up
  If findings_fixed is missing OR false while findings are non-empty AND status is not "blocked", the gate FAILS. Choose one of the three dispositions every time.

Severity: "blocking" = breaks at runtime. "medium" = wrong behavior. "low" = style/cleanup.
If 0 findings: status = "done", findings = [], findings_fixed = true (vacuously — there was nothing to fix).`,

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

DOCS UPDATE — edit prose docs only, then write JSON.

ALREADY DONE (do NOT touch these — handled by the pipeline automatically):
- memory/backlog.json — orchestrator moves the ticket to archive after this step
- memory/backlog-archive.json — orchestrator appends after this step
- memory/closed-bugs.json — orchestrator appends for bugs after this step
- memory/build-log/{today}.md — already appended

Check and update if applicable (skip silently if N/A):
1. memory/SPEC.md — new UI conventions or behaviors
2. memory/ARCHITECTURE.md — if architecture changed
3. memory/DATA_MODEL.md — if data model changed
4. memory/FLOWS.md — if user flows changed
5. Project-specific docs (from config.project_profile.docs_check_files):
{{docs_check_files}}
6. Grep for stale hints/tooltips referencing old behavior
7. memory/code_validation.md — if new coding rule from root_cause

Write {{pipeline_dir}}/{{ticket_id}}.json with steps.docs_update.status = "done":
- files_updated: [{path}] — path only`,
  };

  return templates[stepName] || `Execute step "${stepName}" for ticket {{ticket_id}}.`;
}
