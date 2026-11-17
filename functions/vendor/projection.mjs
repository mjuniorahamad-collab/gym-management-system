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
function freezeTailDays(period, freezes) {
  const original = periodDayKey(period?.expiryDate);
  if (!original) return 0;
  const anchored = anchoredFreezeRanges(period, freezes);
  if (anchored.length === 0) return 0;
  const beyond = anchored.map(([start, end]) => toRange([start, end], { floorKey: addDaysToKey(original, 1) })).filter(Boolean);
  return rangesDays(mergeRanges(beyond));
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

// ../src/utils/dateHelpers.js
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value.toDate === "function") {
    try {
      return value.toDate();
    } catch {
      return null;
    }
  }
  const s = String(value);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? /* @__PURE__ */ new Date(`${s}T12:00:00`) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
function toDateInputValue(dateInput = /* @__PURE__ */ new Date()) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(d.getTime())) return "";
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 6e4);
  return local.toISOString().slice(0, 10);
}

// ../src/utils/payments.js
function safePaymentAmount(amount) {
  const n = Number(amount);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ../src/utils/pt.js
function safeCurrencyNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
function getEffectivePtSurcharge({ ptSurcharge = 0, ptSurchargeOverride }) {
  if (ptSurchargeOverride === void 0 || ptSurchargeOverride === null || ptSurchargeOverride === "") {
    return safeCurrencyNumber(ptSurcharge);
  }
  return safeCurrencyNumber(ptSurchargeOverride);
}
function getMembershipCharge({ plan, isPT = false, ptSurcharge = 0, ptSurchargeOverride }) {
  const base = safeCurrencyNumber(plan?.price);
  const addon = isPT ? Math.max(0, getEffectivePtSurcharge({ ptSurcharge, ptSurchargeOverride })) : 0;
  return { base, addon, total: base + addon };
}

// ../src/utils/currency.js
var MINOR_UNITS_BY_CURRENCY = {
  AUD: 2,
  CAD: 2,
  EUR: 2,
  GBP: 2,
  INR: 2,
  // The Nepalese rupee is not subdivided in practice; paise are not in
  // circulation, so a rupee amount is a whole number.
  NPR: 0,
  USD: 2
};
var DEFAULT_MINOR_UNITS = 2;
var MAX_MINOR_UNITS = 6;
function currencyMinorUnits(currency) {
  const code = String(currency ?? "").trim().toUpperCase();
  if (!code) return DEFAULT_MINOR_UNITS;
  const units = MINOR_UNITS_BY_CURRENCY[code];
  if (!Number.isInteger(units)) return DEFAULT_MINOR_UNITS;
  return Math.min(Math.max(units, 0), MAX_MINOR_UNITS);
}
function roundCurrency(amount, currency) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return 0;
  const units = currencyMinorUnits(currency);
  if (units === 0) return Math.round(value);
  const factor = 10 ** units;
  const scaled = value * factor;
  const nudged = Math.sign(scaled) * (Math.abs(scaled) + Number.EPSILON * Math.abs(scaled));
  return Math.round(nudged) / factor;
}

// ../src/utils/freezeTails.js
var TAIL_UNPRICEABLE = {
  NO_TAIL: "no tail days",
  NO_PLAN: "the plan the freeze was granted against no longer exists",
  NO_DURATION: "the plan has no usable duration in days",
  NO_PRICE: "the plan has no usable price"
};
function rateFromBasis(basis) {
  const total = Number(basis?.total);
  const duration = Number(basis?.durationDays);
  if (!Number.isFinite(duration) || duration <= 0) {
    return { rate: 0, priceable: false, reason: TAIL_UNPRICEABLE.NO_DURATION };
  }
  if (!(total > 0)) {
    return { rate: 0, priceable: false, reason: TAIL_UNPRICEABLE.NO_PRICE };
  }
  return { rate: total / duration, priceable: true, reason: "" };
}
function planDailyRate({ plan, basis, isPT = false, ptSurcharge = 0, ptSurchargeOverride } = {}) {
  if (basis) return rateFromBasis(basis);
  if (!plan) return { rate: 0, priceable: false, reason: TAIL_UNPRICEABLE.NO_PLAN };
  const duration = Number(plan.durationDays);
  if (!Number.isFinite(duration) || duration <= 0) {
    return { rate: 0, priceable: false, reason: TAIL_UNPRICEABLE.NO_DURATION };
  }
  const charge = getMembershipCharge({ plan, isPT, ptSurcharge, ptSurchargeOverride });
  if (!(charge.total > 0)) {
    return { rate: 0, priceable: false, reason: TAIL_UNPRICEABLE.NO_PRICE };
  }
  return { rate: charge.total / duration, priceable: true, reason: "" };
}
function pricingBasisForPeriod(period, plan) {
  const isPT = Boolean(period?.isPT);
  const base = Number(period?.basePrice ?? period?.price);
  const addon = isPT ? Number(period?.ptSurcharge ?? 0) : 0;
  const total = Number.isFinite(base) && Number.isFinite(addon) ? base + addon : NaN;
  const duration = Number(period?.durationDays) > 0 ? Number(period.durationDays) : periodDayCount(period) || Number(plan?.durationDays);
  if (!(total > 0) || !Number.isFinite(duration) || duration <= 0) return null;
  return { total, durationDays: duration };
}
function periodDayCount(period) {
  const start = period?.startDate;
  const expiry = period?.expiryDate;
  if (!start || !expiry) return 0;
  const ms = new Date(expiry).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(ms / 864e5);
}
function freezeTailCharge({
  tailDays = 0,
  plan,
  basis,
  isPT = false,
  ptSurcharge = 0,
  ptSurchargeOverride,
  currency = "INR"
} = {}) {
  const days = Math.max(0, Math.trunc(Number(tailDays) || 0));
  const { rate, priceable, reason } = planDailyRate({ plan, basis, isPT, ptSurcharge, ptSurchargeOverride });
  if (!priceable) {
    return { days, dailyRate: 0, amount: 0, priceable: false, reason, currency };
  }
  if (days === 0) {
    return { days: 0, dailyRate: rate, amount: 0, priceable: true, reason: "", currency };
  }
  return {
    days,
    dailyRate: rate,
    // The single rounding step in the financial engine.
    amount: roundCurrency(rate * days, currency),
    priceable: true,
    reason: "",
    currency
  };
}

// ../src/utils/dues.js
function periodPrice(membership) {
  const price = Number(membership?.price);
  return Number.isFinite(price) && price > 0 ? price : 0;
}
function implicitPeriodPrice({ plan, member, ptSurcharge, ptSurchargeOverride }) {
  return getMembershipCharge({
    plan,
    isPT: Boolean(member?.isPT),
    ptSurcharge,
    ptSurchargeOverride
  }).total;
}
function periodStatus({ dueAmount, totalPaid }) {
  if (dueAmount === 0) return "paid";
  return totalPaid > 0 ? "partial" : "due";
}
function periodSnapshots(doc) {
  return {
    basePrice: Number(doc?.basePrice) || void 0,
    ptSurcharge: Number(doc?.ptSurcharge) || void 0,
    isPT: doc?.isPT,
    freezeTailDays: doc?.freezeTailDays,
    freezeTailAmount: doc?.freezeTailAmount,
    freezeTailSettledFor: doc?.freezeTailSettledFor || null
  };
}
function planLabel(plans, planId) {
  const plan = plans.find((p) => String(p.id) === String(planId));
  return plan?.name || "";
}
function sortByStartDate(list) {
  return [...list].sort(
    (a, b) => String(a.startDate || "").localeCompare(String(b.startDate || ""))
  );
}
function computeMemberLedger({
  member,
  plans = [],
  payments = [],
  memberships = [],
  freezes = [],
  ptSurcharge = 0,
  ptSurchargeOverride
} = {}) {
  if (!member?.id) {
    return { periods: [], openPeriods: [], totals: { billed: 0, paid: 0, due: 0 }, targetMembershipId: void 0 };
  }
  const memberPayments = payments.filter((p) => p && p.memberId === member.id);
  const recordedDocs = sortByStartDate(
    memberships.filter((m) => m && m.id && m.memberId === member.id)
  );
  const plan = plans.find((p) => String(p.id) === String(member.membershipPlanId)) || null;
  const periodDefs = [];
  if (recordedDocs.length === 0) {
    if (!plan) return { periods: [], openPeriods: [], totals: { billed: 0, paid: 0, due: 0 }, targetMembershipId: void 0 };
    const start = parseDate(member.joinDate) || memberPayments.map((p) => parseDate(p.date)).filter(Boolean).sort((a, b) => a - b)[0] || null;
    const duration = Number(plan.durationDays);
    periodDefs.push({
      id: null,
      planId: plan.id,
      label: plan.name || "Membership",
      startDate: start,
      expiryDate: start && Number.isFinite(duration) && duration > 0 ? addDays(start, duration) : null,
      price: implicitPeriodPrice({
        plan,
        member,
        ptSurcharge,
        ptSurchargeOverride: ptSurchargeOverride ?? member?.ptSurchargeOverride
      }),
      implicit: true
    });
  } else {
    const firstRecordedStart = parseDate(recordedDocs[0].startDate);
    const strays = memberPayments.filter((p) => {
      if (safePaymentAmount(p.amount) <= 0) return false;
      const linkedToKnownPeriod = recordedDocs.some((m) => m.id === p.membershipId);
      if (linkedToKnownPeriod) return false;
      const date = parseDate(p.date);
      return date && firstRecordedStart && date < firstRecordedStart;
    });
    if (strays.length > 0 && plan) {
      const earliestStray = strays.map((p) => parseDate(p.date)).filter(Boolean).sort((a, b) => a - b)[0];
      const duration = Number(plan.durationDays);
      periodDefs.push({
        id: null,
        planId: plan.id,
        label: `${plan.name || "Membership"} (earlier)`,
        startDate: earliestStray,
        expiryDate: earliestStray && Number.isFinite(duration) && duration > 0 ? addDays(earliestStray, duration) : null,
        price: implicitPeriodPrice({
          plan,
          member,
          ptSurcharge,
          ptSurchargeOverride: ptSurchargeOverride ?? member?.ptSurchargeOverride
        }),
        implicit: true
      });
    }
    for (const doc of recordedDocs) {
      periodDefs.push({
        id: doc.id,
        planId: doc.planId || "",
        label: doc.planName || planLabel(plans, doc.planId) || "Membership",
        startDate: parseDate(doc.startDate),
        expiryDate: parseDate(doc.expiryDate),
        price: periodPrice(doc),
        implicit: false,
        // The document's own immutable financial snapshots, carried through so
        // downstream pricing never has to reach back to a live plan. `price` above
        // is the derived, payable figure; these are what the member committed to.
        ...periodSnapshots(doc)
      });
    }
  }
  const paidByPeriod = /* @__PURE__ */ new Map();
  let unallocatedPool = 0;
  const knownIds = new Set(recordedDocs.map((m) => m.id));
  for (const payment of memberPayments) {
    const amount = safePaymentAmount(payment.amount);
    if (amount <= 0) continue;
    if (payment.membershipId && knownIds.has(payment.membershipId)) {
      paidByPeriod.set(
        payment.membershipId,
        (paidByPeriod.get(payment.membershipId) || 0) + amount
      );
    } else {
      unallocatedPool += amount;
    }
  }
  const periods = periodDefs.map((def) => {
    const directPaid = def.id ? paidByPeriod.get(def.id) || 0 : 0;
    const needFromPool = Math.max(0, def.price - directPaid);
    const applied = Math.min(unallocatedPool, needFromPool);
    unallocatedPool -= applied;
    const paid = directPaid + applied;
    const due = Math.max(0, def.price - paid);
    return {
      ...def,
      paid,
      due,
      status: periodStatus({ dueAmount: due, totalPaid: paid })
    };
  });
  const openPeriods = periods.filter((p) => p.due > 0);
  return {
    periods,
    openPeriods,
    totals: {
      billed: openPeriods.reduce((s, p) => s + p.price, 0),
      paid: openPeriods.reduce((s, p) => s + p.paid, 0),
      due: openPeriods.reduce((s, p) => s + p.due, 0)
    },
    targetMembershipId: openPeriods.find((p) => !p.implicit)?.id,
    freezeTails: summariseFreezeTails({ periods, freezes, plans, member, ptSurcharge, ptSurchargeOverride })
  };
}
function summariseFreezeTails({ periods, freezes, plans, member, ptSurcharge, ptSurchargeOverride }) {
  if (!Array.isArray(freezes) || freezes.length === 0) return [];
  const settledTailKeys = /* @__PURE__ */ new Map();
  for (const p of periods) {
    const settledFor = p?.freezeTailSettledFor;
    if (!settledFor) continue;
    const prev = settledTailKeys.get(settledFor);
    const stamp = toDateInputValue(parseDate(p.startDate));
    if (!prev || stamp < prev) settledTailKeys.set(settledFor, stamp);
  }
  const out = [];
  for (const period of periods) {
    if (!period?.id) continue;
    const days = freezeTailDays({ ...period, memberId: member?.id }, freezes);
    if (days <= 0) continue;
    const plan = plans.find((p) => String(p.id) === String(period.planId)) || null;
    const isPT = period.isPT ?? member?.isPT ?? false;
    const basis = pricingBasisForPeriod(period, plan);
    const charge = freezeTailCharge({
      tailDays: days,
      basis,
      plan,
      isPT,
      ptSurcharge,
      ptSurchargeOverride: ptSurchargeOverride ?? period.ptSurcharge ?? member?.ptSurchargeOverride
    });
    out.push({
      membershipId: period.id,
      // Carried so a renewal can settle the tail on the same terms the ledger
      // showed, instead of re-deriving them and risking a different number.
      planId: period.planId,
      isPT: period.isPT,
      basis,
      label: "Freeze extension",
      days: charge.days,
      amount: charge.amount,
      priceable: charge.priceable,
      reason: charge.reason,
      // Set once a later renewal has settled this tail. A period's tail is a
      // one-off charge against that period; after it is billed, reporting it again
      // would show the member owing money already taken.
      settledAt: settledTailKeys.get(period.id) || null
    });
  }
  return out;
}

// ../src/utils/duesDrift.js
var DRIFT_FIELDS = Object.freeze(["amountPaid", "amountDue", "paymentStatus"]);
var numberOrZero = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
function duesDriftForMember({
  member,
  plans = [],
  payments = [],
  memberships = []
} = {}) {
  if (!member?.id) return [];
  const ledger = computeMemberLedger({ member, plans, payments, memberships });
  const figuresById = new Map(ledger.periods.filter((p) => p.id).map((p) => [p.id, p]));
  const rows = [];
  for (const period of memberships) {
    if (!period?.id) continue;
    const figures = figuresById.get(period.id);
    if (!figures) continue;
    const stored = {
      amountPaid: numberOrZero(period.amountPaid),
      amountDue: numberOrZero(period.amountDue),
      paymentStatus: period.paymentStatus ?? null
    };
    const expected = {
      amountPaid: figures.paid,
      amountDue: figures.due,
      paymentStatus: figures.status
    };
    const fields = DRIFT_FIELDS.filter((field) => stored[field] !== expected[field]);
    if (fields.length > 0) rows.push({ periodId: period.id, fields, stored, expected });
  }
  return rows;
}
function groupByMember(docs) {
  const grouped = /* @__PURE__ */ new Map();
  for (const doc of docs) {
    if (!doc?.memberId) continue;
    const bucket = grouped.get(doc.memberId);
    if (bucket) bucket.push(doc);
    else grouped.set(doc.memberId, [doc]);
  }
  return grouped;
}
function findDuesDrift({ members = [], plans = [], payments = [], memberships = [] } = {}) {
  const periodsByMember = groupByMember(memberships);
  const paymentsByMember = groupByMember(payments);
  const driftedMembers = [];
  let periodsScanned = 0;
  for (const member of members) {
    if (!member?.id) continue;
    const memberPeriods = periodsByMember.get(member.id) || [];
    periodsScanned += memberPeriods.filter((p) => p.id).length;
    const rows = duesDriftForMember({
      member,
      plans,
      payments: paymentsByMember.get(member.id) || [],
      memberships: memberPeriods
    });
    if (rows.length > 0) {
      driftedMembers.push({
        memberId: member.id,
        memberName: member.name ?? null,
        periods: rows
      });
    }
  }
  return {
    membersScanned: members.filter((m) => m?.id).length,
    periodsScanned,
    driftedMembers,
    driftedPeriods: driftedMembers.reduce((sum, entry) => sum + entry.periods.length, 0)
  };
}
export {
  DEFAULT_GYM_TIMEZONE,
  DRIFT_FIELDS,
  EXPIRING_WITHIN_DAYS,
  PROJECTION_STATUS,
  deriveMemberProjection,
  duesDriftForMember,
  findDuesDrift,
  gymDayKey,
  gymTodayKey,
  resolveGymTimezone
};
