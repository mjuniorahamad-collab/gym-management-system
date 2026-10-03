/**
 * Auth ↔ Firestore reconciliation (READ-ONLY)
 * 
 * This module is for diagnosis and readiness only. It performs NO writes,
 * NO mutations, NO deletions, NO disables, and NO repairs. It also never
 * automatically targets production.
 */

export const FINDING_TYPES = {
  VALID: 'VALID',
  MISSING: 'MISSING',
  ORPHAN: 'ORPHAN',
  UNBOUND: 'UNBOUND',
  INVALID: 'INVALID',
  AMBIGUOUS: 'AMBIGUOUS',
  REQUIRES_MANUAL_REVIEW: 'REQUIRES_MANUAL_REVIEW',
};

export const SEVERITY = {
  INFO: 'INFO',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
  CRITICAL: 'CRITICAL',
};

export function createReconciliationEngine(opts = {}) {
  const findings = [];
  const {
    authUsers = [],
    firestoreUsers = [],
    gyms = [],
    tenantData = [],
  } = opts;

  const authByUid = new Map(authUsers.map((u) => [u.uid, u]));
  const fuByUid = new Map(firestoreUsers.map((u) => [u.uid, u]));
  const gymById = new Map(gyms.map((g) => [g.id, g]));
  const gymsByOwner = new Map();

  for (const g of gyms) {
    const owner = g.ownerUid || (g.data && g.data.ownerUid) || g.owner;
    if (owner) {
      if (!gymsByOwner.has(owner)) gymsByOwner.set(owner, []);
      gymsByOwner.get(owner).push(g);
    }
  }

  for (const a of authUsers) {
    if (!fuByUid.has(a.uid)) {
      findings.push({
        findingType: FINDING_TYPES.MISSING,
        severity: SEVERITY.ERROR,
        uid: a.uid,
        documentPath: `users/${a.uid}`,
        explanation: 'Auth user exists but Firestore profile users/' + a.uid + ' is missing.',
      });
    }
  }

  for (const fu of firestoreUsers) {
    if (!authByUid.has(fu.uid)) {
      findings.push({
        findingType: FINDING_TYPES.ORPHAN,
        severity: SEVERITY.CRITICAL,
        uid: fu.uid,
        gymId: fu.gymId || (fu.data && fu.data.gymId),
        documentPath: `users/${fu.uid}`,
        explanation: 'Firestore profile users/' + fu.uid + ' exists but no matching Auth user found.',
      });
    }
  }

  for (const [uid, fu] of fuByUid) {
    if (!authByUid.has(uid)) continue;
    const p = fu.data || fu;
    const gid = p.gymId;
    if (gid === null || gid === undefined) {
      findings.push({
        findingType: FINDING_TYPES.UNBOUND,
        severity: SEVERITY.ERROR,
        uid,
        documentPath: `users/${uid}`,
        explanation: 'User profile has no gymId (unbound).',
      });
      continue;
    }
    if ((typeof gid === 'string' && gid.trim().length === 0)) {
      findings.push({
        findingType: FINDING_TYPES.INVALID,
        severity: SEVERITY.ERROR,
        uid,
        gymId: gid,
        documentPath: `users/${uid}`,
        explanation: 'User profile has invalid gymId.',
      });
      continue;
    }
    if (!gymById.has(gid)) {
      findings.push({
        findingType: FINDING_TYPES.ORPHAN,
        severity: SEVERITY.CRITICAL,
        uid,
        gymId: gid,
        documentPath: `users/${uid}`,
        explanation: `User profile points to missing gym ${gid}.`,
      });
      continue;
    }
    findings.push({
      findingType: FINDING_TYPES.VALID,
      severity: SEVERITY.INFO,
      uid,
      gymId: gid,
      documentPath: `users/${uid}`,
      explanation: 'Valid user-gym binding.',
    });
  }

  for (const [owner, list] of gymsByOwner) {
    if (list.length > 1) {
      findings.push({
        findingType: FINDING_TYPES.AMBIGUOUS,
        severity: SEVERITY.WARNING,
        uid: owner,
        documentPath: 'gyms/*',
        explanation: 'Owner has multiple gyms; data model expects at most one gym per owner-of-record context.',
      });
    }
  }

  for (const g of gyms) {
    const gid = g.id;
    const owner = g.ownerUid || (g.data && g.data.ownerUid);
    if (!owner) {
      findings.push({
        findingType: FINDING_TYPES.UNBOUND,
        severity: SEVERITY.WARNING,
        gymId: gid,
        documentPath: `gyms/${gid}`,
        explanation: 'Gym has no ownerUid.',
      });
    }
  }

  const byGym = new Map();
  for (const fu of firestoreUsers) {
    const g = (fu.data || fu).gymId;
    if (g) {
      if (!byGym.has(g)) byGym.set(g, []);
      byGym.get(g).push(fu.uid);
    }
  }

  for (const g of gyms) {
    const gid = g.id;
    const owners = gymsByOwner.get(gid) || [];
    const u = byGym.get(gid) || [];
    if (owners.length === 0 && u.length === 0) {
      findings.push({
        findingType: FINDING_TYPES.ORPHAN,
        severity: SEVERITY.WARNING,
        gymId: gid,
        documentPath: `gyms/${gid}`,
        explanation: 'Empty/orphan gym.',
      });
    } else if (owners.length === 0) {
      findings.push({
        findingType: FINDING_TYPES.ORPHAN,
        severity: SEVERITY.WARNING,
        gymId: gid,
        documentPath: `gyms/${gid}`,
        explanation: 'Gym has users but no ownerUid.',
      });
    }
  }

  for (const td of tenantData) {
    const gid = td.gymId || (td.data && td.data.gymId);
    if (gid && !gymById.has(gid)) {
      findings.push({
        findingType: FINDING_TYPES.ORPHAN,
        severity: SEVERITY.CRITICAL,
        gymId: gid,
        documentPath: td.path || (td.collection + '/' + td.id),
        explanation: 'Tenant data points to missing gym ' + gid + '.',
      });
    }
  }

  return findings;
}

export function summarize(f) {
  const byType = new Map();
  const arr = f || [];
  for (const x of arr) {
    byType.set(x.findingType, (byType.get(x.findingType) || 0) + 1);
  }
  return { total: arr.length, byType: Object.fromEntries(byType) };
}

export function toJson(f, o = {}) {
  return JSON.stringify(f || [], null, o.indent || 2);
}
