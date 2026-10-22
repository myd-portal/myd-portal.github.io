export const tevEntityName = "Department of Agriculture - Regional Field Office XIII";
export const tevFundCluster = "1";
export const tevPurpose = "Please see attached Travel Orders";
export const tevOrsOffice = "Department of Agriculture - Regional Field Office XIII";
export const tevOrsOfficeAddress = "Capitol Site, Butuan City, Agusan del Norte";
export const tevCtcDirector = "Engr. Ricardo M. Oñate Jr.";
export const tevCtcDirectorOffice = "Department of Agriculture - RFO XIII";
export const maxItineraryRows = 13;
export const maxCenrrRows = 28;
export const maxOrsStatusRows = 27;
export function formatTaxIdentificationNo(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 9);
  return digits.replace(/(\d{3})(?=\d)/g, "$1-");
}

export const tevOrsBudgetSignatory = { name: "Fatima D. Campos", position: "Chief, Budget Section" };
export const tevDvAccountingSignatory = { name: "Jane V. Mamba", position: "Accounting Section", designation: "Head, Accounting Unit/Authorized Representative" };
export const tevDvApprovingSignatory = { name: "Primitiva O. Arquion", position: "Chief, Admin and Finance Division", designation: "Agency Head/Authorized Representative" };

export const tevOfficialStations = [
  "Department of Agriculture - Regional Office XIII",
  "DA - Integrated Laboratories Division Caraga",
] as const;

export const tevDivisions = [
  "Administrative and Finance Division",
  "Agribusiness and Marketing Assistance Division",
  "Field Operations Division",
  "Finance Division",
  "Integrated Laboratories Division",
  "Planning, Monitoring and Evaluation Division",
  "Regional Agricultural Engineering Division",
  "Regulatory Division",
  "Research Division",
] as const;

export const tevTransportationMeans = ["Boat", "MCH", "RP", "Plane (GS)", "Plane (Credit)", "PUB", "PUV", "Not Applicable"] as const;

export type TevRegionRate = {
  region: string;
  hotelLodging: number;
  breakfast: number;
  lunch: number;
  dinner: number;
  incidentalFee: number;
};

export const tevClaims = [
  { id: "lodging", label: "Hotel / Lodging", rateKey: "hotelLodging", legacyAmount: 750 },
  { id: "breakfast", label: "Breakfast", rateKey: "breakfast", legacyAmount: 150 },
  { id: "lunch", label: "Lunch", rateKey: "lunch", legacyAmount: 150 },
  { id: "dinner", label: "Dinner", rateKey: "dinner", legacyAmount: 150 },
  { id: "incidental", label: "Incidental Fee", rateKey: "incidentalFee", legacyAmount: 300 },
] as const;

export type TevOfficialStation = (typeof tevOfficialStations)[number];
export type TevDivision = (typeof tevDivisions)[number] | "Administrative Division";
export function isTevDivision(value: string): value is (typeof tevDivisions)[number] {
  return tevDivisions.some((division) => division === value);
}
// Keep the former values in the type so existing Firestore records remain readable.
export type TevTransportationMeans = (typeof tevTransportationMeans)[number] | "Plane" | "None" | "";
export type TevClaimId = (typeof tevClaims)[number]["id"];

export type TevProfile = {
  name: string;
  address: string;
  taxIdentificationNo: string;
  position: string;
  unit: string;
};

export type TevTravelReference = {
  travelOrderNo: string;
  toDateRecordsUnit: string;
  dateFrom: string;
  dateTo: string;
};

export type TevItineraryRow = {
  dateFrom: string;
  dateTo: string;
  visitedPlaces: string;
  departureTimeFrom: string;
  departureTimeTo: string;
  region: string;
  claims: TevClaimId[];
  meansOfTransportation: TevTransportationMeans;
  transportation: string;
};

export type TevItinerary = {
  id: string;
  dateFrom: string;
  dateTo: string;
  rows: TevItineraryRow[];
};

export type TevCertificationOfTravel = {
  strictlyInAccordance: boolean;
  cutShort: boolean;
  cutShortAmount: string;
  cutShortOrNo: string;
  cutShortDate: string;
  extended: boolean;
  otherDeviation: boolean;
  otherExplanation: string;
};

export type MyTevRecord = {
  id: string;
  ownerId: string;
  sharedWith?: string[];
  createdById?: string;
  sourceRecordId?: string;
  createdAt?: unknown;
  profile: TevProfile;
  month: string;
  officialStation: TevOfficialStation;
  travelReferences: TevTravelReference[];
  evidenceOfTravel: string;
  evidenceOfTravelOptions?: string[];
  certificationOfTravel?: TevCertificationOfTravel;
  divisionName: TevDivision;
  itineraries: TevItinerary[];
};

export type TevTotals = { perDiem: number; transportation: number; grandTotal: number };

const transportNeedsAmount = new Set<TevTransportationMeans>(["Boat", "MCH", "Plane (Credit)", "PUV", "PUB"]);
const signatoryByDivision: Record<TevDivision, { name: string; position: "Chief" | "OIC" }> = {
  "Field Operations Division": { name: "Melody M. Guimary", position: "Chief" },
  "Planning, Monitoring and Evaluation Division": { name: "Gemma A. Asufre", position: "Chief" },
  "Administrative and Finance Division": { name: "Claide Jane D. Calamba", position: "OIC" },
  "Administrative Division": { name: "Claide Jane D. Calamba", position: "OIC" },
  "Finance Division": { name: "Primitiva O. Arquion", position: "Chief" },
  "Agribusiness and Marketing Assistance Division": { name: "Lynn A. Pareñas", position: "Chief" },
  "Regional Agricultural Engineering Division": { name: "Engr. Rene Q. Morales", position: "Chief" },
  "Research Division": { name: "Edelmira R. Luminarias", position: "Chief" },
  "Regulatory Division": { name: "Johnny M. Concon", position: "Chief" },
  "Integrated Laboratories Division": { name: "Esther B. Cardeño, DVM", position: "Chief" },
};

export function blankTevTravelReference(): TevTravelReference {
  return { travelOrderNo: "", toDateRecordsUnit: "", dateFrom: "", dateTo: "" };
}

export function blankTevItineraryRow(): TevItineraryRow {
  return {
    dateFrom: "",
    dateTo: "",
    visitedPlaces: "",
    departureTimeFrom: "",
    departureTimeTo: "",
    region: "",
    claims: [],
    meansOfTransportation: "",
    transportation: "",
  };
}

export function blankTevItinerary(id: string): TevItinerary {
  return {
    id,
    dateFrom: "",
    dateTo: "",
    rows: [blankTevItineraryRow()],
  };
}

export function defaultTevCertificationOfTravel(): TevCertificationOfTravel {
  return {
    strictlyInAccordance: false,
    cutShort: false,
    cutShortAmount: "",
    cutShortOrNo: "",
    cutShortDate: "",
    extended: false,
    otherDeviation: false,
    otherExplanation: "",
  };
}

export function stationAddress(station: TevOfficialStation) {
  return station === tevOfficialStations[1]
    ? "Purok - 8, Brgy. Taguibo, Butuan City, Agusan del Norte"
    : tevOrsOfficeAddress;
}

export function divisionForUnit(_unit: string) {
  return "Field Operations Division";
}

export function divisionSignatory(division: TevDivision) {
  return signatoryByDivision[division];
}

export function tevDivisionLabel(division: TevDivision) {
  switch (division) {
    case "Administrative Division": return "Administrative and Finance Division";
    case "Planning, Monitoring and Evaluation Division": return "PMED";
    case "Agribusiness and Marketing Assistance Division": return "AMAD";
    case "Regional Agricultural Engineering Division": return "RAED";
    default: return division;
  }
}

export function chargedToForUnit(unit: string) {
  if (unit === "AGRISTAT" || unit === "FOD-AGRISTAT") return "Agricultural Statistics Funds";
  if (unit === "AMIA" || unit === "FOD-AMIA") return "AMIA Funds";
  if (unit === "DRRM" || unit === "FOD-DRRM") return "DRRM Funds";
  return "Field Operations Division Funds";
}

export function numberAmount(value: string | number) {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

export function parseTevRegionRates(csv: string): TevRegionRate[] {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  const headers = lines[0]?.split(",").map((value) => value.trim()) ?? [];
  const columnIndex = (name: string) => headers.indexOf(name);
  const columns = {
    region: columnIndex("Region"),
    hotelLodging: columnIndex("Hotel / Lodging"),
    breakfast: columnIndex("Breakfast"),
    lunch: columnIndex("Lunch"),
    dinner: columnIndex("Dinner"),
    incidentalFee: columnIndex("Incidental Fee"),
  };
  if (Object.values(columns).some((index) => index < 0)) throw new Error("The tev_rate.csv file is missing a required column.");

  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((value) => value.trim());
    const amount = (index: number) => {
      const value = Number(cells[index]?.replace(/,/g, ""));
      if (!Number.isFinite(value) || value < 0) throw new Error("The tev_rate.csv file contains an invalid per diem amount.");
      return value;
    };
    const region = cells[columns.region];
    if (!region) throw new Error("The tev_rate.csv file contains a row without a region.");
    return {
      region,
      hotelLodging: amount(columns.hotelLodging),
      breakfast: amount(columns.breakfast),
      lunch: amount(columns.lunch),
      dinner: amount(columns.dinner),
      incidentalFee: amount(columns.incidentalFee),
    };
  });
}

export function isTevTransportationAmountRequired(means: TevTransportationMeans) {
  return transportNeedsAmount.has(means);
}

export function normalizeTevTransportationMeansForEditor(means: TevTransportationMeans): TevTransportationMeans {
  if (means === "Plane") return "Plane (GS)";
  if (means === "None") return "";
  return means;
}

export function displayTevTransportationMeans(means: TevTransportationMeans) {
  if (means === "Plane (GS)" || means === "Plane (Credit)" || means === "Plane") return "Plane";
  return means === "None" || means === "Not Applicable" ? "" : means;
}

export async function loadTevRegionRates() {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const response = await fetch(`${basePath}/tev_rate.csv`);
  if (!response.ok) throw new Error("Regional per diem rates could not be loaded.");
  return parseTevRegionRates(await response.text());
}

export function perDiemForClaims(claims: TevClaimId[], region: string, rates: TevRegionRate[]) {
  const regionRate = rates.find((rate) => rate.region === region);
  return tevClaims.reduce((total, claim) => {
    if (!claims.includes(claim.id)) return total;
    // Records created before Region was added have no region field; preserve their previous amounts.
    const amount = regionRate ? regionRate[claim.rateKey] : region ? 0 : claim.legacyAmount;
    return total + amount;
  }, 0);
}

export function transportationForRow(row: TevItineraryRow) {
  return isTevTransportationAmountRequired(row.meansOfTransportation) ? numberAmount(row.transportation) : 0;
}

export function totalsForItinerary(itinerary: TevItinerary, rates: TevRegionRate[]): TevTotals {
  const perDiem = itinerary.rows.reduce((total, row) => total + perDiemForClaims(row.claims, row.region, rates), 0);
  const transportation = itinerary.rows.reduce((total, row) => total + transportationForRow(row), 0);
  return { perDiem, transportation, grandTotal: perDiem + transportation };
}

export function totalsForRecord(itineraries: TevItinerary[], rates: TevRegionRate[]): TevTotals {
  return itineraries.reduce<TevTotals>((totals, itinerary) => {
    const current = totalsForItinerary(itinerary, rates);
    return {
      perDiem: totals.perDiem + current.perDiem,
      transportation: totals.transportation + current.transportation,
      grandTotal: totals.grandTotal + current.grandTotal,
    };
  }, { perDiem: 0, transportation: 0, grandTotal: 0 });
}

export function cenrrRows(itineraries: TevItinerary[]) {
  return itineraries.flatMap((itinerary) => itinerary.rows
    .map((row) => ({ ...row, amount: transportationForRow(row) }))
    .filter((row) => row.meansOfTransportation === "MCH"
      && Boolean(row.dateFrom || row.dateTo || row.visitedPlaces || row.amount)
      && row.amount >= 1
      && row.amount <= 300));
}

export function formatTevDate(value: string, options: Intl.DateTimeFormatOptions = { month: "long", day: "numeric", year: "numeric" }) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-PH", { ...options, timeZone: "UTC" }).format(date);
}

export function formatTevDateRange(from: string, to: string) {
  if (!from) return formatTevDate(to);
  if (!to || from === to) return formatTevDate(from);
  return `${formatTevDate(from)} - ${formatTevDate(to)}`;
}

export function formatTevTime(value: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return value;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return value;
  return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
}

export function formatTevAmount(value: number) {
  return new Intl.NumberFormat("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function joinTevList(values: string[], conjunction = "and") {
  if (values.length < 2) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")}, ${conjunction} ${values[values.length - 1]}`;
}

export function formatTevTravelOrderNumbers(references: TevTravelReference[]) {
  return joinTevList(references.map((reference) => reference.travelOrderNo.trim()).filter(Boolean), "&");
}

export function formatTevTravelDateRanges(references: TevTravelReference[]) {
  const ranges = references.filter((reference) => reference.dateFrom || reference.dateTo);
  if (!ranges.length) return "";
  const parse = (value: string) => {
    if (!value) return null;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const parsed = ranges.map((reference) => ({ from: parse(reference.dateFrom), to: parse(reference.dateTo) }));
  if (parsed.some((range) => !range.from || !range.to)) {
    return joinTevList(ranges.map((reference) => formatTevDateRange(reference.dateFrom, reference.dateTo)));
  }
  const years = new Set(parsed.flatMap((range) => [range.from!.getUTCFullYear(), range.to!.getUTCFullYear()]));
  const months = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
  const labels = parsed.map(({ from, to }) => {
    const start = from!;
    const end = to!;
    const startMonth = months[start.getUTCMonth()];
    const endMonth = months[end.getUTCMonth()];
    const startDay = start.getUTCDate();
    const endDay = end.getUTCDate();
    const sameMonth = start.getUTCFullYear() === end.getUTCFullYear() && start.getUTCMonth() === end.getUTCMonth();
    const label = sameMonth
      ? `${startMonth} ${startDay}${startDay === endDay ? "" : `-${endDay}`}`
      : `${startMonth} ${startDay}-${endMonth} ${endDay}`;
    return years.size === 1 ? label : `${label}, ${end.getUTCFullYear()}`;
  });
  const year = years.size === 1 ? `, ${parsed[parsed.length - 1].to!.getUTCFullYear()}` : "";
  return `${joinTevList(labels)}${year}`;
}

export function formatTevRecordsUnitDates(references: TevTravelReference[]) {
  const months = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
  const dates = references.flatMap((reference) => {
    const value = reference.toDateRecordsUnit ?? "";
    if (!value) return [];
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? [] : [date];
  });
  if (!dates.length) return "";

  const years = new Set(dates.map((date) => date.getUTCFullYear()));
  const groups = new Map<string, { year: number; month: number; days: number[] }>();
  dates.forEach((date) => {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const key = `${year}-${month}`;
    const group = groups.get(key) ?? { year, month, days: [] };
    const day = date.getUTCDate();
    if (!group.days.includes(day)) group.days.push(day);
    groups.set(key, group);
  });

  const labels = [...groups.values()].map(({ year, month, days }) => {
    const yearLabel = years.size > 1 ? `, ${year}` : "";
    return `${months[month]} ${days.sort((first, second) => first - second).join(", ")}${yearLabel}`;
  });
  const finalYear = years.size === 1 ? `, ${dates[0].getUTCFullYear()}` : "";
  return `${labels.join(", ")}${finalYear}`;
}

export function formatTevTravelReferences(references: TevTravelReference[]) {
  const orderNumbers = formatTevTravelOrderNumbers(references);
  const recordsUnitDates = formatTevRecordsUnitDates(references);
  if (!orderNumbers) return recordsUnitDates;
  return recordsUnitDates ? `${orderNumbers}, dated ${recordsUnitDates}` : orderNumbers;
}
