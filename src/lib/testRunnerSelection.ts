import type {
  TestDanger,
  TestRunnerCatalog,
  TestRunnerCase,
} from '../types';

const DANGER_RANK: Record<TestDanger, number> = {
  safe: 0,
  read: 1,
  write: 2,
  destructive: 3,
};

export interface TestRunnerSelectionSummary {
  requiredInputs: string[];
  danger: TestDanger;
}

export function highestTestDanger(tests: readonly TestRunnerCase[]): TestDanger {
  return tests.reduce<TestDanger>(
    (highest, test) => {
      const danger = test.danger ?? 'safe';
      return DANGER_RANK[danger] > DANGER_RANK[highest] ? danger : highest;
    },
    'safe',
  );
}

/**
 * Return the cases explicitly assigned to a profile by the project bridge.
 * Older catalogs without `nodeIds` remain compatible and expose every case.
 */
export function testsForTestRunnerProfile(
  catalog: TestRunnerCatalog,
  profileId: string,
): TestRunnerCase[] {
  if (!profileId) return catalog.tests;
  const profile = catalog.profiles.find((item) => item.id === profileId);
  if (!profile?.nodeIds) return catalog.tests;
  const allowed = new Set(profile.nodeIds);
  return catalog.tests.filter((test) => allowed.has(test.nodeId));
}

export function filterTestRunnerNodeIds(
  catalog: TestRunnerCatalog,
  profileId: string,
  selectedNodeIds: readonly string[],
): string[] {
  const profile = catalog.profiles.find((item) => item.id === profileId);
  if (!profileId || !profile?.nodeIds) return [...selectedNodeIds];
  const allowed = new Set(
    testsForTestRunnerProfile(catalog, profileId).map((test) => test.nodeId),
  );
  return selectedNodeIds.filter((nodeId) => allowed.has(nodeId));
}

export function summarizeTestRunnerSelection(
  catalog: TestRunnerCatalog,
  profileId: string,
  selectedNodeIds: ReadonlySet<string>,
): TestRunnerSelectionSummary {
  const selectedTests = testsForTestRunnerProfile(catalog, profileId)
    .filter((test) => selectedNodeIds.has(test.nodeId));
  if (selectedTests.length > 0) {
    return summarizeTests(selectedTests);
  }

  if (profileId) {
    const profile = catalog.profiles.find((item) => item.id === profileId);
    return {
      requiredInputs: uniqueSorted(profile?.requiredInputs ?? []),
      danger: profile?.danger ?? 'safe',
    };
  }

  return summarizeTests(catalog.tests);
}

function summarizeTests(tests: readonly TestRunnerCase[]): TestRunnerSelectionSummary {
  return {
    requiredInputs: uniqueSorted(tests.flatMap((test) => test.requiredInputs ?? [])),
    danger: highestTestDanger(tests),
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
