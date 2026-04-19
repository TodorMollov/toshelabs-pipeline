/**
 * Validate pipeline step artifacts against step config rules.
 * Returns { pass: boolean, failures: string[] }
 */
export function validateStep(artifacts, stepConfig, planArtifacts = null) {
  const failures = [];

  if (!stepConfig.validation) return { pass: true, failures };

  for (const rule of stepConfig.validation) {
    const value = getNestedField(artifacts, rule.field);

    switch (rule.rule) {
      case 'non_empty_array':
        if (!Array.isArray(value) || value.length === 0) {
          failures.push(`${rule.field}: expected non-empty array, got ${JSON.stringify(value)}`);
        }
        break;

      case 'non_empty_string':
        // Check "unless" condition
        if (rule.unless) {
          const unlessVal = getNestedField(artifacts, rule.unless.field);
          if (unlessVal === rule.unless.equals) continue;
        }
        // Accept strings, objects, and arrays as long as they have content
        if (value !== null && value !== undefined && typeof value === 'object') {
          if (Object.keys(value).length === 0 && (!Array.isArray(value) || value.length === 0)) {
            failures.push(`${rule.field}: expected non-empty string, got empty object`);
          }
        } else if (typeof value !== 'string' || value.trim().length === 0) {
          failures.push(`${rule.field}: expected non-empty string, got ${JSON.stringify(value)}`);
        }
        break;

      case 'equals':
        if (value !== rule.value) {
          failures.push(`${rule.field}: expected ${rule.value}, got ${value}`);
        }
        break;

      case 'greater_than':
        // Review frequently omits checklist_items_checked even though it
        // actually ran the checklist (findings_considered is populated).
        // Infer a fallback count from sibling review artifacts so we don't
        // reject honest work for a missing integer.
        if ((value === undefined || value === null) && rule.field === 'checklist_items_checked') {
          const findings = getNestedField(artifacts, 'findings');
          const considered = getNestedField(artifacts, 'findings_considered');
          const inferred = (Array.isArray(findings) ? findings.length : 0)
            + (Array.isArray(considered) ? considered.length : 0);
          if (inferred > (rule.value || 0)) break; // ok, skip failure
        }
        if (typeof value !== 'number' || value <= (rule.value || 0)) {
          failures.push(`${rule.field}: expected > ${rule.value || 0}, got ${value}`);
        }
        break;

      case 'equals_or_missing':
        if (value !== undefined && value !== null && value !== rule.value) {
          failures.push(`${rule.field}: expected ${rule.value} or missing, got ${value}`);
        }
        break;

      case 'one_of':
        if (!rule.values.includes(value)) {
          failures.push(`${rule.field}: expected one of [${rule.values}], got ${value}`);
        }
        break;

      case 'true_if_findings': {
        const findings = getNestedField(artifacts, 'findings');
        const stepStatus = getNestedField(artifacts, 'status');
        // Review exposes two valid "I found but didn't fix" signals:
        //   - status=blocked: can't fix, needs intervention
        //   - findings_fixed='deferred': handed back to implement/next cycle
        // Either unblocks the gate. Only a silent "findings with no
        // disposition" is a real failure.
        if (Array.isArray(findings) && findings.length > 0
            && value !== true && value !== 'deferred'
            && stepStatus !== 'blocked') {
          failures.push(`${rule.field}: findings exist but findings_fixed is neither true, 'deferred', nor was status set to blocked`);
        }
        break;
      }

      case 'covers_plan_criteria': {
        // Plan deliverables (files_to_change[].what_to_do) must map to tests.
        // Two escape valves so this gate doesn't block purely mechanical work:
        //   1. Bullets prefixed with "[no-test]" skip the check entirely —
        //      reserved for pure refactors / data additions that aren't
        //      testable as discrete cases.
        //   2. Small shortfalls (≤2 absolute or ≤20% relative, whichever is
        //      larger) produce a warning instead of a hard fail. The plan
        //      often bundles plumbing with behavioural changes, and the LLM
        //      writes sensible tests for the behavioural slice but can't
        //      manufacture cases for "pass field X through".
        if (planArtifacts?.files_to_change) {
          const map = Array.isArray(value) ? value : [];
          const mappedCriteria = map.map((m) => (m.criterion || '').toLowerCase());
          const testable = [];
          for (const planned of planArtifacts.files_to_change) {
            const desc = (typeof planned === 'object' ? planned.what_to_do : planned) || '';
            if (!desc) continue;
            if (/^\s*\[no-test\]/i.test(desc)) continue; // explicitly skipped
            testable.push(desc);
          }
          const unmapped = [];
          for (const desc of testable) {
            const descLower = desc.toLowerCase();
            const covered = mappedCriteria.some((c) =>
              c.includes(descLower.slice(0, 30)) || descLower.includes(c.slice(0, 30))
            );
            if (!covered) unmapped.push(desc.slice(0, 80));
          }
          const tolerance = Math.max(2, Math.ceil(testable.length * 0.2));
          if (unmapped.length > tolerance) {
            failures.push(`criteria_to_test_map: ${unmapped.length}/${testable.length} plan deliverable(s) have no matching test (tolerance ${tolerance}): ${unmapped.slice(0, 5).join(' | ')}${unmapped.length > 5 ? ` …+${unmapped.length - 5} more` : ''}`);
          } else if (unmapped.length > 0) {
            // Within tolerance — log as warning so the step still passes.
            console.warn(`[validator] tests_red shortfall within tolerance (${unmapped.length}/${testable.length}): ${unmapped.slice(0, 3).join(' | ')}`);
          }
        }
        break;
      }

      case 'covers_plan':
        if (planArtifacts?.files_to_change) {
          const changedPaths = (value || []).map((f) =>
            typeof f === 'object' ? f.path : f
          );
          const skippedPaths = (artifacts.files_skipped || []).map((f) =>
            typeof f === 'object' ? f.path : f
          );
          const unaccounted = [];
          for (const planned of planArtifacts.files_to_change) {
            const plannedPath = typeof planned === 'object' ? planned.path : planned;
            const changed = changedPaths.some((c) => c.includes(plannedPath) || plannedPath.includes(c));
            const skipped = skippedPaths.some((s) => s.includes(plannedPath) || plannedPath.includes(s));
            if (!changed && !skipped) {
              unaccounted.push(plannedPath);
            }
          }
          if (unaccounted.length > 0) {
            failures.push(`${unaccounted.length}/${planArtifacts.files_to_change.length} planned files unaccounted for (not changed, not skipped with reason): ${unaccounted.join(', ')}`);
          }
        }
        break;

      default:
        failures.push(`Unknown validation rule: ${rule.rule}`);
    }
  }

  return { pass: failures.length === 0, failures };
}

function getNestedField(obj, path) {
  return path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
}
