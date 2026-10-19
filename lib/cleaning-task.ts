export const cleaningTaskUnits = ["AGRISTAT", "AMIA", "DRRM"] as const;
export type CleaningTaskUnit = (typeof cleaningTaskUnits)[number];

export type CleaningTaskAssignment = {
  id: string;
  weekStart: string;
  month: string;
  weekNumber: number;
  unit: CleaningTaskUnit;
  startAt: { toDate: () => Date };
  endAt: { toDate: () => Date };
  assignedBy: string;
  assignedAt?: unknown;
};

export type CleaningTaskImage = {
  id: string;
  unit: CleaningTaskUnit;
  imageURL: string;
  fileKey: string;
  previousFileKey: string;
  previousFileOwnerId: string;
  uploaderId: string;
  uploaderName: string;
  submittedWeekStart: string;
  location: string;
  uploadedAt?: { toDate: () => Date };
};

export type CleaningTaskCalendarWeek = {
  weekStart: string;
  weekNumber: number;
  days: Array<{ date: string; inMonth: boolean }>;
};

export function manilaDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(dateKey: string, amount: number) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function weekStartForDate(dateKey: string) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - mondayOffset);
  return date.toISOString().slice(0, 10);
}

export function currentCleaningWeekStart(date = new Date()) {
  return weekStartForDate(manilaDateKey(date));
}

export function cleaningWeekNumber(month: string, weekStart: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const firstDay = new Date(Date.UTC(year, monthNumber - 1, 1));
  const offset = firstDay.getUTCDay();
  const weekMonday = new Date(`${weekStart}T00:00:00Z`);
  const firstSunday = new Date(Date.UTC(year, monthNumber - 1, 1 - offset));
  const firstWeekMonday = new Date(firstSunday);
  firstWeekMonday.setUTCDate(firstWeekMonday.getUTCDate() + 1);
  return Math.floor((weekMonday.getTime() - firstWeekMonday.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
}

export function cleaningTaskCalendarWeeks(month: string): CleaningTaskCalendarWeek[] {
  const [year, monthNumber] = month.split("-").map(Number);
  if (!year || !monthNumber || monthNumber < 1 || monthNumber > 12) return [];
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const firstDay = new Date(Date.UTC(year, monthNumber - 1, 1));
  const firstSunday = addDays(`${month}-01`, -firstDay.getUTCDay());
  const count = Math.ceil((daysInMonth + firstDay.getUTCDay()) / 7);

  return Array.from({ length: count }, (_, index) => {
    const sunday = addDays(firstSunday, index * 7);
    const weekStart = addDays(sunday, 1);
    return {
      weekStart,
      weekNumber: index + 1,
      days: Array.from({ length: 7 }, (_, dayIndex) => {
        const date = addDays(sunday, dayIndex);
        return { date, inMonth: date.slice(0, 7) === month };
      }),
    };
  });
}

export function shiftCleaningMonth(month: string, amount: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  if (!year || !monthNumber || monthNumber < 1 || monthNumber > 12) return manilaDateKey().slice(0, 7);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + amount, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function cleaningWeekTimestamps(weekStart: string) {
  const start = new Date(`${weekStart}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 5 * 24 * 60 * 60 * 1000);
  return { startAt: start, endAt: end };
}

export function displayCleaningDate(value: unknown) {
  if (!value || typeof (value as { toDate?: unknown }).toDate !== "function") return "—";
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
  }).format((value as { toDate: () => Date }).toDate());
}

export function displayCleaningDateTime(value: unknown) {
  if (!value || typeof (value as { toDate?: unknown }).toDate !== "function") return "Date and time unavailable";
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short",
  }).format((value as { toDate: () => Date }).toDate());
}

export function isCleaningTaskUnit(value: unknown): value is CleaningTaskUnit {
  return typeof value === "string" && cleaningTaskUnits.includes(value as CleaningTaskUnit);
}

export function isCleaningTaskImageOutdated(image: CleaningTaskImage, currentWeekStart: string) {
  const uploadedAt = image.uploadedAt?.toDate?.().getTime();
  if (typeof uploadedAt !== "number" || !Number.isFinite(uploadedAt)) return false;

  const { startAt, endAt } = cleaningWeekTimestamps(currentWeekStart);
  return uploadedAt < startAt.getTime() || uploadedAt >= endAt.getTime();
}
