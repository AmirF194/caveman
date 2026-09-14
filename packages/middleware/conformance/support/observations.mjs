/** Only an observation emitted by an executing test can back its journey claim. */
export const observationPrefix = 'CAVEMAN_MIDDLEWARE_OBSERVATION ';

export function recordedObservations(output) {
  const observations = [];
  for (const line of output.split('\n')) {
    const offset = line.indexOf(observationPrefix);
    if (offset < 0) continue;
    try {
      const item = JSON.parse(line.slice(offset + observationPrefix.length));
      if (typeof item.test_id === 'string' && typeof item.assertion === 'string' &&
          item.observation && typeof item.observation === 'object' && !Array.isArray(item.observation) && Object.keys(item.observation).length) observations.push(item);
    } catch { /* Truncated and malformed observations cannot certify anything. */ }
  }
  return observations;
}

export function hasObservation(output, expected) {
  if (!expected?.observation || typeof expected.observation !== 'object' || Array.isArray(expected.observation)) return false;
  return recordedObservations(output).some(item =>
    item.cell_id === expected.cell_id && item.acceptance_id === expected.acceptance_id &&
    item.test_id === expected.test_id && item.assertion === expected.assertion &&
    JSON.stringify(item.observation) === JSON.stringify(expected.observation));
}
