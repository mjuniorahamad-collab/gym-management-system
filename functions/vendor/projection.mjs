// ../src/utils/gymTime.js
var DEFAULT_GYM_TIMEZONE = "Asia/Kolkata";
var formatterCache = /* @__PURE__ */ new Map();
function partsFormatter(timeZone) {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}
function resolveGymTimezone(timezone) {
  const tz = typeof timezone === "string" ? timezone.trim() : "";
  if (!tz) return DEFAULT_GYM_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_GYM_TIMEZONE;
  }
}
function zonedParts(date, timeZone) {
  const out = {};
  for (const { type, value } of partsFormatter(timeZone).formatToParts(date)) {
    if (type !== "literal") out[type] = value;
  }
  return out;
}
function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value.toDate === "function") {
    try {
      const d2 = value.toDate();
      return Number.isNaN(d2.getTime()) ? null : d2;
    } catch {
      return null;
    }
  }
  const s = String(value);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? /* @__PURE__ */ new Date(`${s}T12:00:00Z`) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
function gymDayKey(value, timezone = DEFAULT_GYM_TIMEZONE) {
  if (typeof value === "string") {
    const s = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  }
  const d = toDate(value);
  if (!d) return "";
  const p = zonedParts(d, resolveGymTimezone(timezone));
  return `${p.year}-${p.month}-${p.day}`;
}
function gymTodayKey(timezone = DEFAULT_GYM_TIMEZONE) {
  return gymDayKey(/* @__PURE__ */ new Date(), timezone);
}
function addDaysToKey(dateOnly, days) {
  const [y, m, d] = dateOnly.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(
    shifted.getUTCDate()
  ).padStart(2, "0")}`;
}

// ../src/utils/membershipPeriods.js
function periodDayKey(value) {
  if (!value) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof value.toDate === "function") {
    try {
      return value.toDate().toISOString().slice(0, 10);
    } catch {
      return "";
    }
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  }
  return "";
}
var keyCompare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function sortPeriods(periods) {
  return [...Array.isArray(periods) ? periods : []].filter(Boolean).sort((a, b) => {
    const byStart = keyCompare(periodDayKey(a.startDate), periodDayKey(b.startDate));
    if (byStart !== 0) return byStart;
    const byCreated = keyCompare(String(a.createdAt?.toDate?.() ?? a.createdAt ?? ""), String(b.createdAt?.toDate?.() ?? b.createdAt ?? ""));
    if (byCreated !== 0) return byCreated;
    return keyCompare(String(a.id ?? ""), String(b.id ?? ""));
  });
}
function periodsForMember(periods, memberId) {
  if (memberId === null || memberId === void 0 || memberId === "") return [];
  return sortPeriods((Array.isArray(periods) ? periods : []).filter(
    (p) => p && String(p.memberId) === String(memberId)
  ));
}
function periodExpiryKey(period) {
  return periodDayKey(period?.effectiveExpiry) || periodDayKey(period?.expiryDate);
}
function isPeriodCurrent(period, todayKey) {
  const start = periodDayKey(period?.startDate);
  const expiry = periodExpiryKey(period);
  if (!start || !expiry) return false;
  if (keyCompare(expiry, start) < 0) return false;
  return keyCompare(start, todayKey) <= 0 && keyCompare(todayKey, expiry) <= 0;
}
function resolvePeriodState(periods, { today, timezone } = {}) {
  const tz = resolveGymTimezone(timezone);
  const todayKey = today || gymTodayKey(tz);
  const own = sortPeriods(periods);
  const usable = own.filter((p) => periodDayKey(p.startDate) && periodDayKey(p.expiryDate));
  const current = usable.filter((p) => isPeriodCurrent(p, todayKey)).pop() || null;
  const past = [...usable].reverse().find((p) => keyCompare(periodDayKey(p.expiryDate), todayKey) < 0) || null;
  const future = own.find((p) => keyCompare(periodDayKey(p.startDate), todayKey) > 0) || null;
  const lapsed = !current && Boolean(past);
  return {
    todayKey,
    periods: own,
    hasPeriods: own.length > 0,
    current,
    past,
    future,
    expired: lapsed,
    notStarted: !current && !past && Boolean(future)
  };
}
function daysToExpiry(period, todayKey) {
  const expiry = periodExpiryKey(period);
  if (!expiry || !todayKey) return null;
  const dayNum = (key) => {
    const [y, m, d] = key.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((dayNum(expiry) - dayNum(todayKey)) / 864e5);
}

// ../src/utils/membershipFreezes.js
var FREEZE_KIND = "freeze";
var CANCELLATION_KIND = "cancellation";
function daysBetweenKeys(a, b) {
  const ka = periodDayKey(a);
  const kb = periodDayKey(b);
  if (!ka || !kb) return null;
  const ms = Date.parse(`${kb}T00:00:00Z`) - Date.parse(`${ka}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.round(ms / 864e5);
}
function normalizeFreeze(doc) {
  if (!doc || typeof doc !== "object") return null;
  const startDate = periodDayKey(doc.startDate);
  const expiryDate = periodDayKey(doc.expiryDate);
  const isCancellation = doc.kind === CANCELLATION_KIND;
  if (!isCancellation && (!startDate || !expiryDate)) return null;
  if (startDate && expiryDate && daysBetweenKeys(startDate, expiryDate) < 0) return null;
  return {
    id: doc.id ? String(doc.id) : "",
    kind: isCancellation ? CANCELLATION_KIND : FREEZE_KIND,
    memberId: doc.memberId != null ? String(doc.memberId) : "",
    periodId: doc.periodId != null ? String(doc.periodId) : "",
    startDate,
    expiryDate,
    cancelsFreezeId: doc.cancelsFreezeId != null ? String(doc.cancelsFreezeId) : "",
    reason: typeof doc.reason === "string" ? doc.reason : ""
  };
}
function normalizeFreezes(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeFreeze).filter(Boolean);
}
function cancelledFreezeIds(freezes) {
  const out = /* @__PURE__ */ new Set();
  for (const f of normalizeFreezes(freezes)) {
    if (f.kind === CANCELLATION_KIND && f.cancelsFreezeId) out.add(f.cancelsFreezeId);
  }
  return out;
}
function toRange(raw, { floorKey = "", ceilingKey = "" } = {}) {
  const rawStart = Array.isArray(raw) ? raw[0] : raw?.startDate;
  const rawEnd = Array.isArray(raw) ? raw[1] : raw?.expiryDate;
  const start = periodDayKey(rawStart);
  const end = periodDayKey(rawEnd);
  if (!start || !end) return null;
  const floor = floorKey ? periodDayKey(floorKey) : "";
  const ceiling = ceilingKey ? periodDayKey(ceilingKey) : "";
  const lo = floor && start < floor ? floor : start;
  const hi = ceiling && end > ceiling ? ceiling : end;
  if ((daysBetweenKeys(lo, hi) ?? -1) < 0) return null;
  return [lo, hi];
}
function mergeRanges(ranges) {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const merged = [sorted[0]];
  for (const [start, end] of sorted.slice(1)) {
    const current = merged[merged.length - 1];
    if (start <= addDaysToKey(current[1], 1)) {
      if (end > current[1]) current[1] = end;
      continue;
    }
    merged.push([start, end]);
  }
  return merged;
}
function rangesDays(ranges) {
  let days = 0;
  for (const [start, end] of ranges) {
    days += (daysBetweenKeys(start, end) ?? 0) + 1;
  }
  return days;
}
function anchoredFreezeRanges(period, freezes) {
  const original = periodDayKey(period?.expiryDate);
  const periodStart = periodDayKey(period?.startDate);
  const live = activeFreezesForPeriod(freezes, { memberId: period?.memberId, periodId: period?.id });
  if (live.length === 0) return [];
  const clipped = live.map((f) => toRange(f, { floorKey: periodStart })).filter(Boolean);
  const merged = mergeRanges(clipped);
  if (!original) return merged;
  return merged.filter(([start]) => start <= original);
}
function countFrozenDays(period, freezes) {
  return rangesDays(anchoredFreezeRanges(period, freezes));
}
function freezeUntilKey(period, freezes) {
  const anchored = anchoredFreezeRanges(period, freezes);
  if (anchored.length === 0) return "";
  return anchored[anchored.length - 1][1];
}
function effectiveExpiryKey(period, freezes) {
  const original = periodDayKey(period?.expiryDate);
  if (!original) return null;
  const frozenDays = countFrozenDays(period, freezes);
  if (frozenDays <= 0) return original;
  return addDaysToKey(original, frozenDays);
}
function frozenDaysForPeriod(period, freezes) {
  return countFrozenDays(period, freezes);
}
function activeFreezesForPeriod(freezes, { memberId, periodId } = {}) {
  const mine = String(memberId ?? "");
  const myPeriod = String(periodId ?? "");
  const cancelled = cancelledFreezeIds(freezes);
  return normalizeFreezes(freezes).filter(
    (f) => f.kind === FREEZE_KIND && f.memberId === mine && (!myPeriod || f.periodId === myPeriod) && !cancelled.has(f.id)
  );
}
function applyFreezes(periods, freezes) {
  if (!Array.isArray(periods)) return [];
  return periods.map((p) => {
    if (!p) return p;
    if (frozenDaysForPeriod(p, freezes) <= 0) return p;
    const effective = effectiveExpiryKey(p, freezes);
    return effective ? { ...p, effectiveExpiry: effective } : p;
  });
}

// ../src/utils/memberProjection.js
var EXPIRING_WITHIN_DAYS = 7;
var PROJECTION_STATUS = {
  ACTIVE: "active",
  EXPIRING: "expiring",
  EXPIRED: "expired"
};
var EMPTY = {
  status: null,
  hasCurrentPeriod: false,
  periodId: null,
  periodBasis: null,
  membershipStart: null,
  effectiveExpiry: null,
  freezeUntil: null,
  isFrozen: false,
  isPT: false,
  expiringWithinDays: null
};
function deriveMemberProjection({
  memberId,
  memberships,
  freezes,
  timezone,
  today
} = {}) {
  const tz = resolveGymTimezone(timezone);
  const suppliedToday = today ? gymDayKey(today, tz) : "";
  const todayKey = today ? suppliedToday : gymTodayKey(tz);
  const own = periodsForMember(Array.isArray(memberships) ? memberships : [], memberId);
  const freezeList = Array.isArray(freezes) ? freezes : [];
  const state = resolvePeriodState(applyFreezes(own, freezeList), { today: todayKey, timezone: tz });
  const basis = state.current || state.past || null;
  const basisKind = state.current ? "current" : state.past ? "past" : null;
  if (!todayKey || !basis) {
    return { memberId: memberId ?? null, timezone: tz, today: todayKey, ...EMPTY };
  }
  const period = { ...basis, memberId: basis.memberId ?? memberId };
  const start = periodDayKey(period.startDate);
  const effective = effectiveExpiryKey(period, freezeList);
  const until = freezeUntilKey(period, freezeList);
  const days = daysToExpiry({ ...period, effectiveExpiry: effective }, todayKey);
  let status = PROJECTION_STATUS.EXPIRED;
  if (state.current) {
    status = days !== null && days <= EXPIRING_WITHIN_DAYS ? PROJECTION_STATUS.EXPIRING : PROJECTION_STATUS.ACTIVE;
  }
  const isFrozen = anchoredFreezeRanges(period, freezeList).some(
    ([from, to]) => from <= todayKey && todayKey <= to
  );
  return {
    memberId: memberId ?? null,
    timezone: tz,
    today: todayKey,
    status,
    hasCurrentPeriod: Boolean(state.current),
    periodId: period.id ?? null,
    periodBasis: basisKind,
    membershipStart: start || null,
    effectiveExpiry: effective || null,
    freezeUntil: until || null,
    isFrozen,
    // The period's own snapshot, not the member's live PT flag: a surcharge toggled
    // on the member today must not rewrite what this period was sold as.
    isPT: Boolean(period.isPT),
    expiringWithinDays: days
  };
}
export {
  DEFAULT_GYM_TIMEZONE,
  EXPIRING_WITHIN_DAYS,
  PROJECTION_STATUS,
  deriveMemberProjection,
  gymDayKey,
  gymTodayKey,
  resolveGymTimezone
};
