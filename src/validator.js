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
        if (typeof value !== 'string' || value.trim().length === 0) {
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

      case 'one_of':
        if (!rule.values.includes(value)) {
          failures.push(`${rule.field}: expected one of [${rule.values}], got ${value}`);
        }
        break;

      case 'true_if_findings':
        const findings = getNestedField(artifacts, 'findings');
        if (Array.isArray(findings) && findings.length > 0 && value !== true) {
          failures.push(`${rule.field}: findings exist but findings_fixed is not true`);
        }
        break;

      case 'covers_plan':
        if (planArtifacts?.files_to_change) {
          const changedPaths = (value || []).map((f) =>
            typeof f === 'object' ? f.path : f
          );
          for (const planned of planArtifacts.files_to_change) {
            const plannedPath = typeof planned === 'object' ? planned.path : planned;
            if (!changedPaths.some((c) => c.includes(plannedPath) || plannedPath.includes(c))) {
              failures.push(`files_changed missing planned file: ${plannedPath}`);
            }
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
