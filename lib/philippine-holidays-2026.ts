export type PhilippineHolidayCategory =
  | "Regular Holiday"
  | "Special (Non-Working) Day"
  | "Special (Working) Day"
  | "Additional Special (Non-Working) Day";

export type PhilippineHoliday = {
  date: string;
  name: string;
  category: PhilippineHolidayCategory;
};

export const PHILIPPINE_HOLIDAYS_2026: PhilippineHoliday[] = [
  { date: "2026-01-01", name: "New Year's Day", category: "Regular Holiday" },
  { date: "2026-02-17", name: "Chinese New Year", category: "Additional Special (Non-Working) Day" },
  { date: "2026-02-25", name: "EDSA People Power Revolution Anniversary", category: "Special (Working) Day" },
  { date: "2026-04-02", name: "Maundy Thursday", category: "Regular Holiday" },
  { date: "2026-04-03", name: "Good Friday", category: "Regular Holiday" },
  { date: "2026-04-04", name: "Black Saturday", category: "Additional Special (Non-Working) Day" },
  { date: "2026-04-09", name: "Araw ng Kagitingan", category: "Regular Holiday" },
  { date: "2026-05-01", name: "Labor Day", category: "Regular Holiday" },
  { date: "2026-06-12", name: "Independence Day", category: "Regular Holiday" },
  { date: "2026-08-21", name: "Ninoy Aquino Day", category: "Special (Non-Working) Day" },
  { date: "2026-08-31", name: "National Heroes Day", category: "Regular Holiday" },
  { date: "2026-11-01", name: "All Saints' Day", category: "Special (Non-Working) Day" },
  { date: "2026-11-02", name: "All Souls' Day", category: "Additional Special (Non-Working) Day" },
  { date: "2026-11-30", name: "Bonifacio Day", category: "Regular Holiday" },
  { date: "2026-12-08", name: "Feast of the Immaculate Conception of Mary", category: "Special (Non-Working) Day" },
  { date: "2026-12-24", name: "Christmas Eve", category: "Additional Special (Non-Working) Day" },
  { date: "2026-12-25", name: "Christmas Day", category: "Regular Holiday" },
  { date: "2026-12-30", name: "Rizal Day", category: "Regular Holiday" },
  { date: "2026-12-31", name: "Last Day of the Year", category: "Additional Special (Non-Working) Day" },
];
