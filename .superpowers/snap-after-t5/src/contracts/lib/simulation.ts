/** Provenance marker for development fake/unavailable checkout responses. */
export const UNCONFIGURED_FAKE_SIMULATION = 'unconfigured-fake' as const;

export type UnconfiguredFakeSimulation = typeof UNCONFIGURED_FAKE_SIMULATION;
