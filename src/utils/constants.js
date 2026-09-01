export const ROLES = {
  owner: 'owner',
  admin: 'admin',
  frontDesk: 'front-desk',
  trainer: 'trainer',
}

export const ROLE_LABELS = {
  owner: 'Owner',
  admin: 'Admin',
  'front-desk': 'Front Desk',
  trainer: 'Trainer',
}

export const ROLE_LEVELS = {
  owner: 4,
  admin: 3,
  'front-desk': 2,
  trainer: 1,
}

export const STAFF_ROLES = [ROLES.owner, ROLES.admin, ROLES.frontDesk, ROLES.trainer]

export const PERMISSIONS = {
  'members.view': ['owner', 'admin', 'front-desk', 'trainer'],
  'members.write': ['owner', 'admin', 'front-desk'],
  'members.delete': ['owner', 'admin'],
  'finance.view': ['owner', 'admin'],
  'finance.write': ['owner', 'admin'],
  'finance.delete': ['owner'],
  'trainers.view': ['owner', 'admin', 'front-desk', 'trainer'],
  'trainers.write': ['owner', 'admin'],
  'classes.write': ['owner', 'admin', 'front-desk'],
  'settings.write': ['owner'],
  'audit.view': ['owner', 'admin'],
  'attendance.write': ['owner', 'admin', 'front-desk'],
  'reports.view': ['owner', 'admin'],
  'seed.data': ['owner', 'admin'],
}

export const PAYMENT_METHODS = [
  'Cash',
  'Card',
  'eSewa',
  'Khalti',
  'Bank Transfer',
  'Other',
]

export const EXPENSE_CATEGORIES = [
  'Rent',
  'Utilities',
  'Equipment',
  'Salaries',
  'Marketing',
  'Maintenance',
  'Insurance',
  'Other',
]

export const FITNESS_GOALS = [
  'Weight Loss',
  'Muscle Gain',
  'Weight Gain',
  'Fat Loss / Body Recomposition',
  'Strength',
  'General Fitness',
  'Endurance',
  'Other',
]

export const MEMBER_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'expired', label: 'Expired' },
  { value: 'frozen', label: 'Frozen' },
]

export const DAYS_OF_WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

export const CURRENCIES = [
  { code: 'NPR', label: 'NPR — Nepalese Rupee', symbol: 'रू' },
  { code: 'USD', label: 'USD — US Dollar', symbol: '$' },
  { code: 'EUR', label: 'EUR — Euro', symbol: '€' },
  { code: 'GBP', label: 'GBP — British Pound', symbol: '£' },
  { code: 'INR', label: 'INR — Indian Rupee', symbol: '₹' },
  { code: 'AUD', label: 'AUD — Australian Dollar', symbol: 'A$' },
  { code: 'CAD', label: 'CAD — Canadian Dollar', symbol: 'C$' },
]

export const DATE_FORMATS = [
  { value: 'MMM D, YYYY', label: 'May 5, 2026' },
  { value: 'DD/MM/YYYY', label: '05/05/2026' },
  { value: 'YYYY-MM-DD', label: '2026-05-05' },
]

export const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: 'LayoutDashboard', end: true },
  { to: '/members', label: 'Members', icon: 'Users', permission: 'members.view' },
  { to: '/trainers', label: 'Trainers', icon: 'Dumbbell', permission: 'trainers.view' },
  { to: '/classes', label: 'Classes', icon: 'CalendarDays', permission: 'members.view' },
  { to: '/attendance', label: 'Attendance', icon: 'ClipboardCheck', permission: 'members.view' },
  { to: '/payments', label: 'Payments', icon: 'Wallet', permission: 'finance.view' },
  { to: '/expenses', label: 'Expenses', icon: 'Receipt', permission: 'finance.view' },
  { to: '/plans', label: 'Membership Plans', icon: 'BadgePercent', permission: 'finance.view' },
  { to: '/reports', label: 'Reports', icon: 'BarChart3', permission: 'reports.view' },
  { to: '/settings', label: 'Settings', icon: 'Settings', permission: 'settings.write' },
]
