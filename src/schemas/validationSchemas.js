import { z } from 'zod'
import { isValidTimezone } from '@/utils/gymTime'
import { RECEIPT_PREFIX_RULES, receiptPrefixRejection } from '@/utils/receiptPrefix'

const email = z.string().min(1, 'Email is required').email('Enter a valid email')
const phone = z
  .string()
  .min(7, 'Phone must be at least 7 digits')
  .regex(/^[+\d\s()-]+$/, 'Enter a valid phone number')

export const loginSchema = z.object({
  email,
  password: z.string().min(6, 'Password must be at least 6 characters'),
})

export const signupSchema = z
  .object({
    name: z.string().min(2, 'Name must be at least 2 characters').max(80),
    email,
    password: z.string().min(6, 'Password must be at least 6 characters').max(128),
    confirmPassword: z.string().min(1, 'Confirm your password'),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })

const receiptPrefixField = z
  .string({ required_error: RECEIPT_PREFIX_RULES, invalid_type_error: RECEIPT_PREFIX_RULES })
  .superRefine((value, ctx) => {
    if (receiptPrefixRejection(value) !== null) {
      ctx.addIssue({ code: 'custom', message: RECEIPT_PREFIX_RULES })
    }
  })

export const gymOnboardingSchema = z.object({
  gymName: z.string().min(2, 'Gym name must be at least 2 characters').max(80),
  tagline: z.string().optional().or(z.literal('')),
  receiptPrefix: receiptPrefixField,
})

export const ptSurchargeSchema = z
  .coerce
  .number({ invalid_type_error: 'PT surcharge must be a number' })
  .min(0, 'PT surcharge cannot be negative')
  .max(100000000, 'PT surcharge is too large')

export const memberSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(80),
  email: email.optional().or(z.literal('')),
  phone,
  dob: z.string().optional().or(z.literal('')),
  gender: z.enum(['Male', 'Female', 'Other']),
  address: z.string().optional().or(z.literal('')),
  fatherName: z.string().optional().or(z.literal('')),
  emergencyName: z.string().optional().or(z.literal('')),
  emergencyPhone: z.string().optional().or(z.literal('')),
  notes: z.string().optional().or(z.literal('')),
  membershipPlanId: z.string().optional().or(z.literal('')),
  // `status` is deliberately ABSENT.
  //
  // It used to be a required enum the form submitted, which meant staff could
  // hand-assign a member's cached status to any of active/expired/frozen and the
  // app would store it — decoupling the projection from the membership periods
  // that actually decide it, with no record of who overrode what.
  //
  // Status is now an OUTPUT of the projection engine, written by the server and
  // displayed read-only. A member is made current by creating or renewing a
  // membership period, which is a fact with an audit trail; it is not made
  // current by picking a dropdown.
  joinDate: z.string().optional().or(z.literal('')),
  ptSurchargeOverride: z
    .union([z.literal(''), ptSurchargeSchema])
    .optional()
    .transform((v) => (v === '' ? null : v)),
})

export const trainerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(80),
  email: email.optional().or(z.literal('')),
  phone,
  specialization: z.string().min(2, 'Specialization is required').max(80),
  hourlyRate: z.coerce.number().min(0, 'Rate cannot be negative').max(1000000),
  hireDate: z.string().optional().or(z.literal('')),
  active: z.boolean().default(true),
})

export const planSchema = z.object({
  name: z.string().min(2, 'Plan name is required').max(80),
  durationDays: z.coerce
    .number({ invalid_type_error: 'Duration must be a number' })
    .int()
    .min(1, 'Duration must be at least 1 day')
    .max(3650),
  price: z.coerce.number().min(0, 'Price cannot be negative').max(100000000),
  features: z.string().optional().or(z.literal('')),
  active: z.boolean().default(true),
})

export const paymentSchema = z.object({
  memberId: z.string().min(1, 'Select a member'),
  planId: z.string().optional().or(z.literal('')),
  membershipId: z.string().optional().or(z.literal('')),
  amount: z.coerce.number().min(1, 'Amount must be greater than 0').max(100000000),
  method: z.string().min(1, 'Select a payment method'),
  date: z.string().min(1, 'Date is required'),
  note: z.string().optional().or(z.literal('')),
})

export const renewalSchema = z
  .object({
    planId: z.string().min(1, 'Select a membership plan'),
    effectiveMode: z
      .enum(['previous-expiry', 'today', 'custom'], {
        errorMap: () => ({ message: 'Select a renewal start' }),
      })
      .default('previous-expiry'),
    customDate: z.string().optional().or(z.literal('')),
    amount: z.coerce.number().min(0, 'Amount cannot be negative').max(100000000),
    method: z.string().min(1, 'Select a payment method'),
    date: z.string().min(1, 'Date is required'),
    note: z.string().optional().or(z.literal('')),
  })
  .superRefine((v, ctx) => {
    if (v.effectiveMode === 'custom' && !v.customDate) {
      ctx.addIssue({ code: 'custom', path: ['customDate'], message: 'Choose a custom effective date' })
    }
  })

export const membershipPeriodSchema = z
  .object({
    planId: z.string().min(1, 'Select a membership plan'),
    price: z.coerce
      .number({ invalid_type_error: 'Period fee must be a number' })
      .min(0, 'Period fee cannot be negative')
      .max(100000000),
    startDate: z.string().min(1, 'Start date is required'),
    expiryDate: z.string().min(1, 'Expiry date is required'),
  })
  .refine((v) => !v.startDate || !v.expiryDate || v.expiryDate >= v.startDate, {
    message: 'Expiry cannot be before the start date',
    path: ['expiryDate'],
  })

export const expenseSchema = z.object({
  title: z.string().min(2, 'Title is required').max(120),
  category: z.string().min(1, 'Select a category'),
  amount: z.coerce.number().min(1, 'Amount must be greater than 0').max(100000000),
  date: z.string().min(1, 'Date is required'),
  note: z.string().optional().or(z.literal('')),
})

export const classSchema = z.object({
  name: z.string().min(2, 'Class name is required').max(80),
  description: z.string().optional().or(z.literal('')),
  dayOfWeek: z.enum([
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday',
  ]),
  startTime: z.string().min(1, 'Start time is required').regex(/^\d{2}:\d{2}$/, 'Invalid time'),
  endTime: z.string().min(1, 'End time is required').regex(/^\d{2}:\d{2}$/, 'Invalid time'),
  trainerId: z.string().optional().or(z.literal('')),
  capacity: z.coerce.number().int().min(1, 'Capacity must be at least 1').max(500),
  active: z.boolean().default(true),
}).refine((v) => v.endTime > v.startTime, {
  // Without this a class could be saved as 18:00-07:00 and then displayed to
  // members as an 11-hour session. HH:MM strings compare chronologically.
  message: 'End time must be after start time',
  path: ['endTime'],
})

export const weightRecordSchema = z
  .object({
    weight: z.coerce
      .number({ invalid_type_error: 'Weight must be a number' })
      .positive('Weight must be positive')
      .max(500, 'Weight seems too high'),
    date: z.string().min(1, 'Date is required'),
  })
  .refine((v) => !v.date || !Number.isNaN(Date.parse(v.date)), {
    message: 'Enter a valid date',
    path: ['date'],
  })

export const fitnessGoalSchema = z.object({
  fitnessGoal: z.string().optional().or(z.literal('')),
  targetWeight: z.coerce
    .number({ invalid_type_error: 'Target weight must be a number' })
    .positive('Target weight must be positive')
    .max(500, 'Target weight seems too high')
    .optional()
    .or(z.literal('')),
})

export const settingsSchema = z.object({
  gymName: z.string().min(2, 'Gym name is required').max(80),
  tagline: z.string().optional().or(z.literal('')),
  currency: z.string().min(1, 'Select a currency'),
  dateFormat: z.string().min(1, 'Select a date format'),
  receiptPrefix: receiptPrefixField,
  timezone: z
    .string()
    .refine(isValidTimezone, { message: 'Select a valid timezone' }),
})

export const settingsFormSchema = settingsSchema.omit({ receiptPrefix: true })

export const whatsAppLinkSchema = z
  .string()
  .trim()
  .refine((v) => v === '' || isValidWhatsAppGroupLink(v), {
    message: 'Enter a valid WhatsApp group invite link',
  })

/**
 * True for a plausible WhatsApp group invite URL that this app's invite flow
 * supports. Accepts the current WhatsApp group-invite forms (chat.whatsapp.com
 * and chats.whatsapp.com share links, plus the newer whatsapp.com/channel
 * invite path) and upgrades http to https. Rejects unrelated or malformed URLs.
 */
function isValidWhatsAppGroupLink(value) {
  const trimmed = value.trim()
  if (!trimmed) return false
  let url
  try {
    url = new URL(trimmed)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const isWhatsApp = host === 'chat.whatsapp.com' || host === 'chats.whatsapp.com' || host === 'whatsapp.com'
  if (!isWhatsApp) return false
  const path = url.pathname
  const hasInvitePath = /^\/[^/]+/.test(path)
  if (!hasInvitePath) return false
  if (host === 'whatsapp.com') {
    // Only the /channel/<id> style invite is supported on the bare domain.
    return /^\/channel\/.+$/.test(path)
  }
  return true
}
