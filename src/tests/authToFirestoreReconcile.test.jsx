import { describe, it, expect } from 'vitest';
import { FINDING_TYPES, createReconciliationEngine, summarize, toJson } from '@/tools/authToFirestoreReconcile.mjs';

describe('auth ↔ firestore reconciliation', () => {
  it('reports valid perfect state', () => {
    const findings = createReconciliationEngine({
      authUsers: [{ uid: 'u1' }],
      firestoreUsers: [{ uid: 'u1', gymId: 'g1' }],
      gyms: [{ id: 'g1', ownerUid: 'u1' }],
      tenantData: [],
    });
    expect(findings.some(f => f.findingType === FINDING_TYPES.VALID)).toBe(true);
  });

  it('detects missing Firestore profile', () => {
    const findings = createReconciliationEngine({
      authUsers: [{ uid: 'u1' }],
      firestoreUsers: [],
      gyms: [],
    });
    expect(findings.some(f => f.findingType === FINDING_TYPES.MISSING)).toBe(true);
  });

  it('detects orphan Firestore profile with no Auth user', () => {
    const findings = createReconciliationEngine({
      authUsers: [],
      firestoreUsers: [{ uid: 'u2', gymId: 'g1' }],
      gyms: [{ id: 'g1', ownerUid: 'u1' }],
    });
    expect(findings.some(f => f.findingType === FINDING_TYPES.ORPHAN)).toBe(true);
  });

  it('detects unbound profile', () => {
    const findings = createReconciliationEngine({
      authUsers: [{ uid: 'u1' }],
      firestoreUsers: [{ uid: 'u1' }],
      gyms: [],
    });
    expect(findings.some(f => f.findingType === FINDING_TYPES.UNBOUND)).toBe(true);
  });

  it('detects invalid gymId', () => {
    const findings = createReconciliationEngine({
      authUsers: [{ uid: 'u1' }],
      firestoreUsers: [{ uid: 'u1', gymId: '' }],
      gyms: [],
    });
    expect(findings.some(f => f.findingType === FINDING_TYPES.INVALID)).toBe(true);
  });

  it('detects missing gym', () => {
    const findings = createReconciliationEngine({
      authUsers: [{ uid: 'u1' }],
      firestoreUsers: [{ uid: 'u1', gymId: 'gX' }],
      gyms: [],
    });
    expect(findings.some(f => f.findingType === FINDING_TYPES.ORPHAN)).toBe(true);
  });

  it('detects ambiguous multiple gyms per owner', () => {
    const findings = createReconciliationEngine({
      authUsers: [{ uid: 'u1' }],
      firestoreUsers: [],
      gyms: [{ id: 'g1', ownerUid: 'u1' }, { id: 'g2', ownerUid: 'u1' }],
    });
    expect(findings.some(f => f.findingType === FINDING_TYPES.AMBIGUOUS)).toBe(true);
  });

  it('detects empty/orphan gym', () => {
    const findings = createReconciliationEngine({
      authUsers: [],
      firestoreUsers: [],
      gyms: [{ id: 'g1' }],
    });
    expect(findings.length).toBeGreaterThan(0);
  });

  it('tenant data pointing to missing gym', () => {
    const findings = createReconciliationEngine({
      authUsers: [],
      firestoreUsers: [],
      gyms: [],
      tenantData: [{ collection: 'members', id: 'm1', gymId: 'gX', path: 'members/m1' }],
    });
    expect(findings.some(f => f.findingType === FINDING_TYPES.ORPHAN)).toBe(true);
  });

  it('produces deterministic JSON and summarize', () => {
    const findings = createReconciliationEngine({
      authUsers: [{ uid: 'u1' }],
      firestoreUsers: [],
      gyms: [],
    });
    const s = summarize(findings);
    expect(s.total).toBeGreaterThan(0);
    const json = toJson(findings);
    expect(json).toContain('MISSING');
  });
});
