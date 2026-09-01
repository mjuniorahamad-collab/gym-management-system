// Sample data for the Gym Management System.
// Used by seedService (dev only) and kept here so the shapes are easy to inspect.

export const samplePlans = [
  {
    name: 'Day Pass',
    durationDays: 1,
    price: 300,
    features: 'Single-day full access',
    active: true,
  },
  {
    name: 'Monthly',
    durationDays: 30,
    price: 2500,
    features: 'Unlimited gym floor access',
    active: true,
  },
  {
    name: '3 Months',
    durationDays: 90,
    price: 6500,
    features: 'Unlimited access + 2 group classes / week',
    active: true,
  },
  {
    name: '6 Months',
    durationDays: 180,
    price: 11500,
    features: 'Unlimited access + group classes + 1 PT session / month',
    active: true,
  },
  {
    name: 'Annual',
    durationDays: 365,
    price: 20000,
    features: 'Everything + free body composition scan quarterly',
    active: true,
  },
]

export const sampleMembers = [
  { name: 'Aarav Shrestha', email: 'aarav@example.com', phone: '9801234567', gender: 'Male', planIndex: 3, status: 'active', joinDaysAgo: 210, address: 'Baneshwor, Kathmandu' },
  { name: 'Priya Gurung', email: 'priya@example.com', phone: '9812345678', gender: 'Female', planIndex: 1, status: 'active', joinDaysAgo: 95, address: 'Jhamsikhel, Lalitpur', isPT: true },
  { name: 'Rohan Thapa', email: 'rohan@example.com', phone: '9823456789', gender: 'Male', planIndex: 2, status: 'active', joinDaysAgo: 150, address: 'Boudha, Kathmandu' },
  { name: 'Maya Tamang', email: 'maya@example.com', phone: '9834567890', gender: 'Female', planIndex: 0, status: 'expired', joinDaysAgo: 240, address: 'Balaju, Kathmandu' },
  { name: 'Suman Rai', email: 'suman@example.com', phone: '9845678901', gender: 'Male', planIndex: 4, status: 'active', joinDaysAgo: 320, address: 'Gwarko, Lalitpur' },
  { name: 'Anisha Karki', email: 'anisha@example.com', phone: '9856789012', gender: 'Female', planIndex: 1, status: 'active', joinDaysAgo: 40, address: 'Koteshwor, Kathmandu' },
  { name: 'Bibek Magar', email: 'bibek@example.com', phone: '9867890123', gender: 'Male', planIndex: 1, status: 'frozen', joinDaysAgo: 180, address: 'Kalanki, Kathmandu' },
  { name: 'Sneha Adhikari', email: 'sneha@example.com', phone: '9878901234', gender: 'Female', planIndex: 2, status: 'active', joinDaysAgo: 130, address: 'Patan Dhoka, Lalitpur' },
  { name: 'Deepak Rana', email: 'deepak@example.com', phone: '9889012345', gender: 'Male', planIndex: 0, status: 'expired', joinDaysAgo: 60, address: 'Thamel, Kathmandu' },
  { name: 'Kriti Maharjan', email: 'kriti@example.com', phone: '9890123456', gender: 'Female', planIndex: 4, status: 'active', joinDaysAgo: 280, address: 'Kupondole, Lalitpur' },
  { name: 'Nabin Bhandari', email: 'nabin@example.com', phone: '9701234567', gender: 'Male', planIndex: 1, status: 'active', joinDaysAgo: 25, address: 'New Baneshwor, Kathmandu' },
  { name: 'Riya Sherpa', email: 'riya@example.com', phone: '9712345678', gender: 'Female', planIndex: 2, status: 'active', joinDaysAgo: 110, address: 'Chabahil, Kathmandu' },
  { name: 'Prakash Limbu', email: 'prakash@example.com', phone: '9723456789', gender: 'Male', planIndex: 0, status: 'expired', joinDaysAgo: 300, address: 'Maitighar, Kathmandu' },
  { name: 'Sujata Poudel', email: 'sujata@example.com', phone: '9734567890', gender: 'Female', planIndex: 1, status: 'active', joinDaysAgo: 75, address: 'Sanepa, Lalitpur' },
  { name: 'Manish Khadka', email: 'manish@example.com', phone: '9745678901', gender: 'Male', planIndex: 3, status: 'active', joinDaysAgo: 200, address: 'Balkhu, Kathmandu' },
  { name: 'Asha Lamsal', email: 'asha@example.com', phone: '9756789012', gender: 'Female', planIndex: 4, status: 'active', joinDaysAgo: 260, address: 'Dallu, Kathmandu' },
]

export const sampleTrainers = [
  { name: 'Arjun Basnet', email: 'arjun@example.com', phone: '9811000001', specialization: 'Strength & Conditioning', hourlyRate: 1500, hireDaysAgo: 400 },
  { name: 'Sita Sharma', email: 'sita@example.com', phone: '9811000002', specialization: 'Yoga & Mobility', hourlyRate: 1200, hireDaysAgo: 350 },
  { name: 'Kushal Karki', email: 'kushal@example.com', phone: '9811000003', specialization: 'CrossFit', hourlyRate: 1400, hireDaysAgo: 300 },
  { name: 'Pooja Thapa', email: 'pooja@example.com', phone: '9811000004', specialization: 'Zumba & Cardio', hourlyRate: 1100, hireDaysAgo: 260 },
  { name: 'Rajesh Prajapati', email: 'rajesh@example.com', phone: '9811000005', specialization: 'Personal Training', hourlyRate: 1800, hireDaysAgo: 220 },
]

export const sampleClasses = [
  { name: 'Morning Yoga', description: 'Gentle flow to start the day', dayOfWeek: 'Monday', startTime: '06:00', endTime: '07:00', trainerIndex: 1, capacity: 15 },
  { name: 'HIIT Blast', description: 'High intensity interval training', dayOfWeek: 'Tuesday', startTime: '06:30', endTime: '07:30', trainerIndex: 2, capacity: 12 },
  { name: 'Spin Cycle', description: 'Indoor cycling endurance', dayOfWeek: 'Wednesday', startTime: '07:00', endTime: '08:00', trainerIndex: 3, capacity: 15 },
  { name: 'CrossFit Foundations', description: 'Functional strength basics', dayOfWeek: 'Thursday', startTime: '18:00', endTime: '19:00', trainerIndex: 2, capacity: 12 },
  { name: 'Zumba Party', description: 'High-energy dance cardio', dayOfWeek: 'Friday', startTime: '17:30', endTime: '18:30', trainerIndex: 3, capacity: 20 },
  { name: 'Strength Lab', description: 'Barbell strength training', dayOfWeek: 'Saturday', startTime: '10:00', endTime: '11:00', trainerIndex: 0, capacity: 15 },
  { name: 'Weekend Yoga', description: 'Relaxing weekend stretch & breathe', dayOfWeek: 'Sunday', startTime: '08:00', endTime: '09:00', trainerIndex: 1, capacity: 20 },
]

export const sampleExpenses = [
  { title: 'Monthly rent', category: 'Rent', amount: 60000, daysAgo: 2 },
  { title: 'Electricity bill', category: 'Utilities', amount: 8500, daysAgo: 5 },
  { title: 'Equipment maintenance', category: 'Maintenance', amount: 4500, daysAgo: 12 },
  { title: 'Trainer salaries', category: 'Salaries', amount: 150000, daysAgo: 1 },
  { title: 'Instagram marketing', category: 'Marketing', amount: 12000, daysAgo: 8 },
  { title: 'Internet & Wi-Fi', category: 'Utilities', amount: 3000, daysAgo: 15 },
  { title: 'Cleaning supplies', category: 'Other', amount: 2500, daysAgo: 20 },
  { title: 'Insurance premium', category: 'Insurance', amount: 8000, daysAgo: 25 },
]

export const paymentMethods = ['Cash', 'Card', 'eSewa', 'Khalti', 'Bank Transfer']

export const membershipPlanNames = samplePlans.map((p) => p.name)
