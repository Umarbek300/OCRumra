import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resolvePassportIdentity,
  type ExistingCanonicalLink,
  type ExistingIdentityLookup,
  type ResolvePassportIdentityDeps,
  type ResolvePassportIdentityInput,
} from '../src/duplicates/resolvePassportIdentity.js';

const BASE_INPUT: ResolvePassportIdentityInput = {
  normalizedPassportNumber: 'AB1234567',
  passportNumberConfidence: 'high',
  dateOfBirth: '1990-01-01',
  dobConfidence: 'high',
  groupId: 'group-1',
  agentId: 'agent-1',
};

function makeDeps(overrides: {
  identity?: ExistingIdentityLookup | null;
  canonicalLink?: ExistingCanonicalLink | null;
}): ResolvePassportIdentityDeps {
  return {
    findIdentityByKey: async () => overrides.identity ?? null,
    findActiveCanonicalLink: async () => overrides.canonicalLink ?? null,
  };
}

test('resolvePassportIdentity returns NEW_IDENTITY when no identity exists at the key', async () => {
  const decision = await resolvePassportIdentity(BASE_INPUT, makeDeps({ identity: null }));
  assert.deepEqual(decision, { outcome: 'NEW_IDENTITY' });
});

test('resolvePassportIdentity returns REVIEW (low_confidence_field) when passport number is not HIGH', async () => {
  const deps = makeDeps({ identity: { id: 'identity-1' } });
  const decision = await resolvePassportIdentity(
    { ...BASE_INPUT, passportNumberConfidence: 'medium' },
    deps,
  );
  assert.deepEqual(decision, {
    outcome: 'REVIEW',
    reviewReason: 'low_confidence_field',
    identityId: 'identity-1',
    matchedAgainstLinkId: null,
  });
});

test('resolvePassportIdentity returns REVIEW (low_confidence_field) when DOB is not HIGH', async () => {
  const deps = makeDeps({ identity: { id: 'identity-1' } });
  const decision = await resolvePassportIdentity({ ...BASE_INPUT, dobConfidence: 'low' }, deps);
  assert.equal(decision.outcome, 'REVIEW');
  assert.equal((decision as { reviewReason: string }).reviewReason, 'low_confidence_field');
});

test('resolvePassportIdentity returns REVIEW (low_confidence_field) when overall confidence would be HIGH but a field is null', async () => {
  const deps = makeDeps({ identity: { id: 'identity-1' } });
  const decision = await resolvePassportIdentity({ ...BASE_INPUT, dobConfidence: null }, deps);
  assert.equal(decision.outcome, 'REVIEW');
});

test('resolvePassportIdentity returns NEW_GROUP_RECORD when identity exists but has no active canonical link in this group', async () => {
  const deps = makeDeps({ identity: { id: 'identity-1' }, canonicalLink: null });
  const decision = await resolvePassportIdentity(BASE_INPUT, deps);
  assert.deepEqual(decision, { outcome: 'NEW_GROUP_RECORD', identityId: 'identity-1' });
});

test('resolvePassportIdentity does NOT disturb a different group -- only checks the input groupId', async () => {
  let queriedGroupId: string | null = null;
  const deps: ResolvePassportIdentityDeps = {
    findIdentityByKey: async () => ({ id: 'identity-1' }),
    findActiveCanonicalLink: async (_identityId, groupId) => {
      queriedGroupId = groupId;
      return null;
    },
  };
  await resolvePassportIdentity({ ...BASE_INPUT, groupId: 'group-42' }, deps);
  assert.equal(queriedGroupId, 'group-42');
});

test('resolvePassportIdentity returns REVIEW (agent_mismatch) when canonical link belongs to a different agent -- overrides confidence', async () => {
  const deps = makeDeps({
    identity: { id: 'identity-1' },
    canonicalLink: { id: 'link-1', agentId: 'agent-OTHER' },
  });
  const decision = await resolvePassportIdentity(BASE_INPUT, deps);
  assert.deepEqual(decision, {
    outcome: 'REVIEW',
    reviewReason: 'agent_mismatch',
    identityId: 'identity-1',
    matchedAgainstLinkId: 'link-1',
  });
});

test('resolvePassportIdentity returns AUTO_MERGE for exact match, HIGH/HIGH confidence, same group, same agent', async () => {
  const deps = makeDeps({
    identity: { id: 'identity-1' },
    canonicalLink: { id: 'link-1', agentId: 'agent-1' },
  });
  const decision = await resolvePassportIdentity(BASE_INPUT, deps);
  assert.deepEqual(decision, { outcome: 'AUTO_MERGE', identityId: 'identity-1', canonicalLinkId: 'link-1' });
});

test('resolvePassportIdentity treats null agentId on both sides as a match (two unlinked senders), not a mismatch', async () => {
  const deps = makeDeps({
    identity: { id: 'identity-1' },
    canonicalLink: { id: 'link-1', agentId: null },
  });
  const decision = await resolvePassportIdentity({ ...BASE_INPUT, agentId: null }, deps);
  assert.equal(decision.outcome, 'AUTO_MERGE');
});

test('resolvePassportIdentity treats null agentId vs a real agentId as a mismatch -> REVIEW', async () => {
  const deps = makeDeps({
    identity: { id: 'identity-1' },
    canonicalLink: { id: 'link-1', agentId: null },
  });
  const decision = await resolvePassportIdentity({ ...BASE_INPUT, agentId: 'agent-1' }, deps);
  assert.equal(decision.outcome, 'REVIEW');
});
