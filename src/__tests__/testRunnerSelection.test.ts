import { describe, expect, it } from 'vitest';
import {
  filterTestRunnerNodeIds,
  summarizeTestRunnerSelection,
  testsForTestRunnerProfile,
} from '../lib';
import type { TestRunnerCatalog } from '../types';

const catalog: TestRunnerCatalog = {
  schemaVersion: 1,
  runnerId: 'pytest',
  title: 'Tests',
  profiles: [{
    id: 'quick',
    title: 'Quick',
    danger: 'read',
    requiredInputs: ['PROFILE_DEVICE'],
    nodeIds: ['tests/test_safe.py::test_safe'],
  }],
  tests: [
    {
      nodeId: 'tests/test_safe.py::test_safe',
      id: 'safe',
      title: 'Safe',
      kind: 'unit',
      tags: [],
      requires: [],
      requiredInputs: ['DEVICE', 'TOKEN'],
      file: 'tests/test_safe.py',
      danger: 'safe',
    },
    {
      nodeId: 'tests/test_write.py::test_write',
      id: 'write',
      title: 'Write',
      kind: 'device',
      tags: [],
      requires: [],
      requiredInputs: ['DEVICE'],
      file: 'tests/test_write.py',
      danger: 'write',
    },
    {
      nodeId: 'tests/test_destructive.py::test_destructive',
      id: 'destructive',
      title: 'Destructive',
      kind: 'device',
      tags: [],
      requires: [],
      requiredInputs: ['CONFIRM'],
      file: 'tests/test_destructive.py',
      danger: 'destructive',
    },
  ],
};

describe('test runner selection summary', () => {
  it('aggregates every case when All tests is selected', () => {
    expect(summarizeTestRunnerSelection(catalog, '', new Set())).toEqual({
      requiredInputs: ['CONFIRM', 'DEVICE', 'TOKEN'],
      danger: 'destructive',
    });
  });

  it('uses profile metadata when a profile is selected', () => {
    expect(summarizeTestRunnerSelection(catalog, 'quick', new Set())).toEqual({
      requiredInputs: ['PROFILE_DEVICE'],
      danger: 'read',
    });
  });

  it('uses exact checked cases inside the selected profile', () => {
    expect(summarizeTestRunnerSelection(
      catalog,
      'quick',
      new Set(['tests/test_safe.py::test_safe']),
    )).toEqual({
      requiredInputs: ['DEVICE', 'TOKEN'],
      danger: 'safe',
    });
  });

  it('filters visible cases and ignores stale checks from another profile', () => {
    expect(testsForTestRunnerProfile(catalog, 'quick').map((test) => test.id)).toEqual(['safe']);
    expect(filterTestRunnerNodeIds(
      catalog,
      'quick',
      ['tests/test_write.py::test_write'],
    )).toEqual([]);
    expect(summarizeTestRunnerSelection(
      catalog,
      'quick',
      new Set(['tests/test_write.py::test_write']),
    )).toEqual({
      requiredInputs: ['PROFILE_DEVICE'],
      danger: 'read',
    });
  });

  it('keeps catalogs without explicit profile membership backward compatible', () => {
    const legacyCatalog: TestRunnerCatalog = {
      ...catalog,
      profiles: catalog.profiles.map(({ nodeIds: _nodeIds, ...profile }) => profile),
    };
    expect(testsForTestRunnerProfile(legacyCatalog, 'quick')).toHaveLength(3);
  });
});
