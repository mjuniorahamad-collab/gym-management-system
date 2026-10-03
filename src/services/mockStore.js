// In-memory data store used when Firebase is not configured (demo mode).
// Mirrors Firestore collection shapes so the whole UI is testable offline.

import {
  paymentMethods,
  sampleClasses,
  sampleExpenses,
  sampleMembers,
  samplePlans,
  sampleTrainers,
} from './sampleData'
import { formatMemberNo } from '@/utils/memberNo'

const DAY = 86400000
const iso = (ms) => new Date(ms).toISOString()
const mkn = () => `mock-${Math.random().toString(36).slice(2, 10)}`

let initialized = false

export const store = {
  members: [],
  trainers: [],
  membershipPlans: [],
  memberships: [],
  membershipFreezes: [],
  payments: [],
  expenses: [],
  attendance: [],
  classes: [],
  bookings: [],
  weightRecords: [],
  auditLog: [],
  counters: {},
}

function ensure() {
  if (initialized) return
  initialized = true
  const now = Date.now()

  const planIds = samplePlans.map((p) => {
    const id = mkn()
    store.membershipPlans.push({
      id,
      ...p,
      features: p.features.split(', '),
      createdAt: iso(now),
      updatedAt: iso(now),
    })
    return id
  })

  const trainerIds = sampleTrainers.map((t) => {
    const id = mkn()
    store.trainers.push({
      id,
      name: t.name,
      email: t.email,
      phone: t.phone,
      specialization: t.specialization,
      hourlyRate: t.hourlyRate,
      hireDate: iso(now - t.hireDaysAgo * DAY),
      active: true,
      createdAt: iso(now),
      updatedAt: iso(now),
    })
    return id
  })

  const memberIds = sampleMembers.map((member, i) => {
    const id = mkn()
    const planId = planIds[member.planIndex]
    const joinDate = iso(now - member.joinDaysAgo * DAY)
    store.members.push({
      id,
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
      memberNo: formatMemberNo(i + 1),
      status: member.status,
      joinDate,
      memberUid: '',
      createdAt: iso(now),
      updatedAt: iso(now),
    })

    // Every membership period is a first-class record, mirroring production.
    const plan = samplePlans[member.planIndex]
    let originMembershipId = ''
    if (planId && plan) {
      originMembershipId = mkn()
      store.memberships.push({
        id: originMembershipId,
        memberId: id,
        planId,
        planName: plan.name,
        startDate: joinDate,
        expiryDate: iso(new Date(joinDate).getTime() + plan.durationDays * DAY),
        price: plan.price,
        amountPaid: 0,
        amountDue: plan.price,
        paymentStatus: 'due',
        paymentId: null,
        receiptNo: null,
        note: 'Initial membership',
        createdAt: iso(now),
        updatedAt: iso(now),
      })
    }

    if (member.status === 'active') {
      // Demo stories:
      // - index 1 pays part of her fee → visible outstanding balance
      // - index 2 has an older partially-paid period PLUS a fully-paid
      //   renewal, proving old dues survive renewals (the core rule).
      let paidAmount = plan ? plan.price : 0
      if (i === 1) paidAmount = Math.max(0, plan.price - 1500)
      if (originMembershipId) {
        const due = Math.max(0, plan.price - paidAmount)
        store.payments.push({
          id: mkn(),
          memberId: id,
          planId: planId || '',
          membershipId: originMembershipId,
          amount: paidAmount,
          method: paymentMethods[i % paymentMethods.length],
          type: 'membership',
          date: joinDate,
          note: `${plan.name} membership`,
          receiptNo: `HWG-${1000 + i}`,
          createdAt: iso(now),
          updatedAt: iso(now),
        })
        Object.assign(store.memberships.find((m) => m.id === originMembershipId), {
          amountPaid: paidAmount,
          amountDue: due,
          paymentStatus: due === 0 ? 'paid' : paidAmount > 0 ? 'partial' : 'due',
        })
      }
    }
    return id
  })

  // Demo renewal: Rohan Thapa renewed from "3 Months" (₹6,500, only ₹5,000
  // collected → ₹1,500 still owed on the OLD period) into a fully-paid
  // Monthly membership. His old ₹1,500 must stay outstanding.
  {
    const rohanId = memberIds[2]
    const rohan = store.members.find((m) => m.id === rohanId)
    const monthlyPlan = samplePlans[1]
    const monthlyPlanId = planIds[1]
    const oldPeriod = store.memberships.find((m) => m.memberId === rohanId)
    if (rohan && oldPeriod && monthlyPlan) {
      const renewalStart = iso(now - 29 * DAY)
      const renewalId = mkn()
      store.memberships.push({
        id: renewalId,
        memberId: rohanId,
        planId: monthlyPlanId,
        planName: monthlyPlan.name,
        startDate: renewalStart,
        expiryDate: iso(now + 1 * DAY),
        price: monthlyPlan.price,
        amountPaid: monthlyPlan.price,
        amountDue: 0,
        paymentStatus: 'paid',
        paymentId: null,
        receiptNo: 'HWG-renewal-demo',
        note: `Renewal — ${monthlyPlan.name}`,
        createdAt: iso(now),
        updatedAt: iso(now),
      })
      store.payments.push({
        id: mkn(),
        memberId: rohanId,
        planId: monthlyPlanId,
        membershipId: renewalId,
        amount: monthlyPlan.price,
        method: 'Cash',
        type: 'renewal',
        date: renewalStart,
        note: `Renewal — ${monthlyPlan.name}`,
        receiptNo: 'HWG-renewal-demo',
        createdAt: iso(now),
        updatedAt: iso(now),
      })
      Object.assign(rohan, {
        membershipPlanId: monthlyPlanId,
        joinDate: renewalStart,
        status: 'active',
      })
    }
  }

  for (const expense of sampleExpenses) {
    store.expenses.push({
      id: mkn(),
      title: expense.title,
      category: expense.category,
      amount: expense.amount,
      date: iso(now - expense.daysAgo * DAY),
      note: '',
      createdAt: iso(now),
      updatedAt: iso(now),
    })
  }

  const classIds = sampleClasses.map((gymClass) => {
    const id = mkn()
    store.classes.push({
      id,
      name: gymClass.name,
      description: gymClass.description,
      dayOfWeek: gymClass.dayOfWeek,
      startTime: gymClass.startTime,
      endTime: gymClass.endTime,
      trainerId: trainerIds[gymClass.trainerIndex] || '',
      capacity: gymClass.capacity,
      active: true,
      createdAt: iso(now),
      updatedAt: iso(now),
    })
    return id
  })

  for (let d = 0; d < 14; d += 1) {
    const date = iso(now - d * DAY)
    memberIds.forEach((memberId, i) => {
      const present = (d * 7 + i * 3) % 5 !== 0
      if (!present) return
      const hour = 5 + ((i + d) % 9)
      const checkIn = iso(new Date(date).getTime() + hour * 3600000)
      store.attendance.push({
        id: mkn(),
        memberId,
        date,
        checkIn,
        checkOut: iso(new Date(checkIn).getTime() + 75 * 60000),
        source: 'manual',
        createdAt: iso(now),
        updatedAt: iso(now),
      })
    })
  }

  classIds.forEach((classId, c) => {
    for (let i = 0; i < 5; i += 1) {
      store.bookings.push({
        id: mkn(),
        classId,
        memberId: memberIds[(i * 3 + 1 + c) % memberIds.length],
        date: iso(now + (1 + i * 2) * DAY),
        status: 'booked',
        createdAt: iso(now),
        updatedAt: iso(now),
      })
    }
  })
}

const byCreatedDesc = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))

export function mockList(name) {
  ensure()
  return [...store[name]].sort(byCreatedDesc)
}

export function mockGet(name, id) {
  ensure()
  return store[name].find((x) => x.id === id) || null
}

export function mockAdd(name, data) {
  ensure()
  const now = iso(Date.now())
  const doc = { id: mkn(), ...data, createdAt: now, updatedAt: now }
  store[name].unshift(doc)
  return doc.id
}

export function mockUpdate(name, id, data) {
  ensure()
  const doc = store[name].find((x) => x.id === id)
  if (doc) {
    Object.assign(doc, data, { updatedAt: iso(Date.now()) })
  }
}

export function mockRemove(name, id) {
  ensure()
  store[name] = store[name].filter((x) => x.id !== id)
}

export function mockSubscribe(name, onData) {
  onData(mockList(name))
  return () => {}
}

export function mockPage({ name, pageSize = 20, orderField = 'createdAt', direction = 'desc', startAfterRef = null, filters = [], search = null }) {
  ensure()
  let rows = [...store[name]]

  for (const f of filters || []) {
    if (!f?.field) continue
    rows = rows.filter((row) => String(row[f.field]) === String(f.value))
  }

  if (search && search.field && search.value) {
    const q = String(search.value).toLowerCase()
    rows = rows.filter((row) => String(row[search.field] || '').toLowerCase().includes(q))
  }

  const dir = direction === 'asc' ? 1 : -1
  rows.sort((a, b) => {
    const av = a[orderField]
    const bv = b[orderField]
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
    return String(av || '').localeCompare(String(bv || '')) * dir
  })

  const offset = typeof startAfterRef === 'number' ? startAfterRef : 0
  const slice = rows.slice(offset, offset + pageSize)
  return {
    items: slice,
    hasMore: offset + slice.length < rows.length,
    last: offset + slice.length,
  }
}
