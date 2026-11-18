import { createDoc, isReady, listAll, updateDocById } from './firestore'
import { requestReprojection } from './projection'
import { getPtSurcharge } from './pt'
import { requireReceiptPrefix } from './receiptPrefixGuard'
import { getMembershipCharge } from '@/utils/pt'
import {
  paymentMethods,
  sampleClasses,
  sampleExpenses,
  sampleMembers,
  samplePlans,
  sampleTrainers,
} from './sampleData'
import { addDays } from '@/utils/dateHelpers'

const DAY = 86400000
const isoDaysAgo = (days) => new Date(Date.now() - days * DAY).toISOString()
const isoDaysAhead = (days) => new Date(Date.now() + days * DAY).toISOString()

const canSeed = () => import.meta.env.VITE_ENABLE_SEEDING === 'true'

async function collectionIsEmpty(name) {
  const docs = await listAll(name)
  return docs.length === 0
}

async function seedCollections() {
  // Sample receipts are numbered under THIS gym's prefix, read from the
  // authoritative gyms document through the same guard every real payment
  // uses. Seeding must not invent a brand: a hardcoded prefix here would mint
  // receipts that look like another tenant's, and every number it produced
  // would be indistinguishable from a real one.
  const receiptPrefix = await requireReceiptPrefix(undefined, 'seedService')
  if (!receiptPrefix) {
    throw new Error(
      'This gym has no receipt prefix on record, so sample receipts cannot be numbered.'
    )
  }

  // Plans
  const planIds = []
  for (const plan of samplePlans) {
    const id = await createDoc('membershipPlans', {
      ...plan,
      features: plan.features.split(', '),
    })
    planIds.push(id)
  }

  // Trainers
  const trainerIds = []
  for (const trainer of sampleTrainers) {
    const id = await createDoc('trainers', {
      name: trainer.name,
      email: trainer.email,
      phone: trainer.phone,
      specialization: trainer.specialization,
      hourlyRate: trainer.hourlyRate,
      hireDate: isoDaysAgo(trainer.hireDaysAgo),
      active: true,
    })
    trainerIds.push(id)
  }

  // Members — every membership period is created as a first-class record so
  // dues, history and renewals all account through the same ledger. Origin
  // periods are priced through the SAME canonical getMembershipCharge helper
  // the rest of the app uses, so a PT member's first period carries the
  // PT-inclusive amount (gym default, or the member's own override) instead
  // of the bare plan price — mirroring src/pages/Members.jsx.
  const memberIds = []
  const seedPtSurcharge = await getPtSurcharge()
  for (const [index, member] of sampleMembers.entries()) {
    const planId = planIds[member.planIndex]
    const joinDate = isoDaysAgo(member.joinDaysAgo)
    const isPt = Boolean(member.isPT)
    const id = await createDoc('members', {
      name: member.name,
      email: member.email,
      phone: member.phone,
      gender: member.gender,
      address: member.address || '',
      dob: '',
      emergencyName: '',
      emergencyPhone: '',
      notes: '',
      searchName: member.name.toLowerCase(),
      photoUrl: '',
      membershipPlanId: planId || '',
      joinDate,
      memberUid: '',
      isPT: isPt,
      ptSurchargeOverride: member.ptSurchargeOverride == null ? null : member.ptSurchargeOverride,
    })
    // `status` is deliberately not seeded.
    //
    // The sample data declares an intended status per member ('expired' and
    // 'frozen' included), but a projection is not an input — it is an output of
    // the periods written below. Seeding it here would be the client asserting a
    // cache value, which is the exact thing this whole phase removes. The seed's
    // origin periods are written moments later, and the server derives the real
    // status from them; requesting that is the `requestReprojection` call at the
    // end of this loop.
    memberIds.push(id)

    const plan = samplePlans[member.planIndex]
    let originMembershipId = ''
    let originPrice = plan ? Number(plan.price) : 0
    if (planId && plan) {
      originPrice = getMembershipCharge({
        plan,
        isPT: isPt,
        ptSurcharge: seedPtSurcharge,
        ptSurchargeOverride: member.ptSurchargeOverride,
      }).total
      originMembershipId = await createDoc('memberships', {
        memberId: id,
        planId,
        planName: plan.name,
        startDate: joinDate,
        expiryDate: isoDaysAgo(member.joinDaysAgo - plan.durationDays),
        price: originPrice,
        amountPaid: 0,
        amountDue: originPrice,
        paymentStatus: 'due',
        paymentId: null,
        receiptNo: null,
        note: 'Initial membership',
      })
    }

    if (member.status === 'active' && plan) {
      let paidAmount = originPrice ?? plan.price
      if (index === 1) paidAmount = Math.max(0, (originPrice ?? plan.price) - 1500)
      const due = Math.max(0, (originPrice ?? plan.price) - paidAmount)
      if (originMembershipId) {
        await updateDocById('memberships', originMembershipId, {
          amountPaid: paidAmount,
          amountDue: due,
          paymentStatus: due === 0 ? 'paid' : paidAmount > 0 ? 'partial' : 'due',
        })
      }
      await createDoc('payments', {
        memberId: id,
        planId: planId || '',
        membershipId: originMembershipId,
        amount: paidAmount,
        method: paymentMethods[member.joinDaysAgo % paymentMethods.length],
        type: 'membership',
        date: joinDate,
        note: `${plan.name} membership`,
        receiptNo: `${receiptPrefix}-${1000 + memberIds.length}`,
      })
    }

    // Every seeded member now has its authoritative periods, so ask the server
    // to derive the projection. Fire-and-forget on purpose: a failed request
    // leaves a blank status that the nightly sweep repairs, and seeding is a
    // development convenience that must not fail because of it.
    requestReprojection(id)
  }

  // Demo renewal story: Rohan Thapa renewed from "3 Months" (₹6,500 with only
  // ₹5,000 collected → ₹1,500 still owed on the OLD period) into a fully-paid
  // Monthly membership, proving old dues survive renewals.
  {
    const rohanId = memberIds[2]
    const monthlyPlan = samplePlans[1]
    const monthlyPlanId = planIds[1]
    const renewalStart = isoDaysAgo(29)
    const renewalId = await createDoc('memberships', {
      memberId: rohanId,
      planId: monthlyPlanId,
      planName: monthlyPlan.name,
      startDate: renewalStart,
      expiryDate: isoDaysAhead(1),
      price: monthlyPlan.price,
      amountPaid: monthlyPlan.price,
      amountDue: 0,
      paymentStatus: 'paid',
      paymentId: null,
      receiptNo: null,
      note: `Renewal — ${monthlyPlan.name}`,
    })
    await createDoc('payments', {
      memberId: rohanId,
      planId: monthlyPlanId,
      membershipId: renewalId,
      amount: monthlyPlan.price,
      method: 'Cash',
      type: 'renewal',
      date: renewalStart,
      note: `Renewal — ${monthlyPlan.name}`,
      receiptNo: `${receiptPrefix}-${1000 + memberIds.length + 1}`,
    })
    await updateDocById('members', rohanId, {
      membershipPlanId: monthlyPlanId,
      joinDate: renewalStart,
    })
    // The renewal period above is the newest one, so it is the current period and
    // the derived status follows from it. No status written here.
    await requestReprojection(rohanId)
  }

  // Expenses
  for (const expense of sampleExpenses) {
    await createDoc('expenses', {
      title: expense.title,
      category: expense.category,
      amount: expense.amount,
      date: isoDaysAgo(expense.daysAgo),
      note: '',
    })
  }

  // Classes
  const classIds = []
  for (const gymClass of sampleClasses) {
    const id = await createDoc('classes', {
      name: gymClass.name,
      description: gymClass.description,
      dayOfWeek: gymClass.dayOfWeek,
      startTime: gymClass.startTime,
      endTime: gymClass.endTime,
      trainerId: trainerIds[gymClass.trainerIndex] || '',
      capacity: gymClass.capacity,
      active: true,
    })
    classIds.push(id)
  }

  // Attendance for the last 14 days
  for (let d = 0; d < 14; d += 1) {
    const date = isoDaysAgo(d)
    memberIds.forEach((memberId, i) => {
      const present = (d * 7 + i * 3) % 5 !== 0
      if (!present) return
      const hour = 5 + ((i + d) % 9)
      const checkIn = new Date(new Date(date).getTime() + hour * 3600000).toISOString()
      const checkOut = new Date(new Date(checkIn).getTime() + 75 * 60000).toISOString()
      createDoc('attendance', { memberId, date, checkIn, checkOut, source: 'manual' }).catch(() => {})
    })
  }

  // Bookings for next week's classes
  for (const classId of classIds) {
    for (let i = 0; i < 5; i += 1) {
      const memberId = memberIds[(i * 3 + 1) % memberIds.length]
      const date = isoDaysAhead(1 + i * 2)
      createDoc('bookings', { classId, memberId, date, status: 'booked' }).catch(() => {})
    }
  }
}

/**
 * Seeds sample data ONLY when explicitly enabled in development
 * (VITE_ENABLE_SEEDING=true) and the target collections are empty.
 */
export async function seedIfNeeded() {
  if (!isReady() || !canSeed()) return { seeded: false, reason: 'disabled' }
  const empty = await collectionIsEmpty('members')
  if (!empty) return { seeded: false, reason: 'has-data' }
  await seedCollections()
  return { seeded: true, reason: 'ok' }
}

/** Manual admin action — loads sample data into empty collections. */
export async function loadSampleData() {
  if (!isReady()) throw new Error('Firebase is not configured')
  const empty = await collectionIsEmpty('members')
  if (!empty) throw new Error('Collections already contain data. Delete existing data first.')
  await seedCollections()
}

export { canSeed }

export function daysLeftForPlan(startIso, durationDays) {
  const start = new Date(startIso)
  const end = addDays(start, durationDays)
  return Math.ceil((end.getTime() - Date.now()) / DAY)
}
