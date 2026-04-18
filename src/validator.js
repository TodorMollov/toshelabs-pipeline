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

      case 'true_if_findings':
        const findings = getNestedField(artifacts, 'findings');
        const stepStatus = getNestedField(artifacts, 'status');
        // If review found critical issues it can't fix, it marks status=blocked — that's valid
        if (Array.isArray(findings) && findings.length > 0 && !value && stepStatus !== 'blocked') {
          failures.push(`${rule.field}: findings exist but findings_fixed is not true`);
        }
        break;

      case 'covers_plan_criteria':
        // Every plan deliverable (files_to_change[].what_to_do) must map to a test
        if (planArtifacts?.files_to_change) {
          const map = Array.isArray(value) ? value : [];
          const mappedCriteria = map.map((m) => (m.criterion || '').toLowerCase());
          const unmapped = [];
          for (const planned of planArtifacts.files_to_change) {
            const desc = (typeof planned === 'object' ? planned.what_to_do : planned) || '';
            if (!desc) continue;
            const descLower = desc.toLowerCase();
            // Check if any criterion in the map is a reasonable match (substring overlap)
            const covered = mappedCriteria.some((c) =>
              c.includes(descLower.slice(0, 30)) || descLower.includes(c.slice(0, 30))
            );
            if (!covered) {
              unmapped.push(desc.slice(0, 80));
            }
          }
          if (unmapped.length > 0) {
            failures.push(`criteria_to_test_map: ${unmapped.length} plan deliverable(s) have no matching test: ${unmapped.join(' | ')}`);
          }
        }
        break;

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
