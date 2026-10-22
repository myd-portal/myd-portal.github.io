import { tevDivisions, type TevDivision } from "@/lib/mytev";

export type AccountProfileFields = {
  office?: unknown;
  division?: unknown;
  assignment?: unknown;
  projectProgram?: unknown;
  unit?: unknown;
  profileFieldsVersion?: unknown;
};

export type AccountProfileSelection = {
  office: string;
  division: string;
  unit: string;
  assignment: string;
};

export const accountOfficeOptions = [
  "Division",
  "Office of the Regional Executive Director",
] as const;

export const accountDivisionOptions = [
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

export const executiveOfficeDivisionOptions = [
  "Office of the Regional Executive Director",
  "RTD for Operations",
  "RTD for Research and Regulations",
] as const;

const fieldOperationsUnitOptions = [
  "4K",
  "AGRISTAT",
  "AMIA",
  "DRRM",
  "APCO - ADN",
  "APCO - ADS",
  "APCO - SDN",
  "APCO - SDS",
  "APCO - PDI",
  "CFIDP",
  "Corn Program",
  "ELCAC",
  "Extension and Partnership",
  "F2C2",
  "Field Operations Division",
  "Gender and Development",
  "Halal Projects",
  "HVCD Program",
  "IPM",
  "Livestock Program",
  "NUPA Program",
  "Organic Agriculture Program",
  "Rice Program",
  "RSBSA",
  "SAAD",
  "Soybean Program",
] as const;

const unitsByDivision: Record<string, readonly string[]> = {
  "Administrative and Finance Division": ["Administrative and Finance Division", "General Services Section", "Human Resource Section"],
  "Agribusiness and Marketing Assistance Division": ["Agribusiness and Marketing Assistance Division"],
  "Field Operations Division": fieldOperationsUnitOptions,
  "Finance Division": ["Budget Section", "Accounting Section", "Finance Division"],
  "Integrated Laboratories Division": ["Integrated Laboratories Division", "NHSP"],
  "Planning, Monitoring and Evaluation Division": ["Information and Communications Technology Unit", "Planning, Monitoring and Evaluation Division"],
  "Regional Agricultural Engineering Division": ["Regional Agricultural Engineering Division"],
  "Regulatory Division": ["Regional Agricultural Engineering Division"],
  "Research Division": ["Del Monte RES", "Modernization and ORDA", "Research Division", "Tagbina RES", "Trento RES"],
};

export function divisionsForOffice(office: string): readonly string[] {
  if (office === "Division") return accountDivisionOptions;
  if (office === "Office of the Regional Executive Director") return executiveOfficeDivisionOptions;
  return [] as const;
}

export function unitsForOfficeDivision(office: string, division: string) {
  if (office === "Division") return unitsByDivision[division] ?? [];
  if (office === "Office of the Regional Executive Director" && executiveOfficeDivisionOptions.includes(division as (typeof executiveOfficeDivisionOptions)[number])) {
    return [division];
  }
  return [] as const;
}

export const accountPositionOptions = [
  "Administrative Aide I",
  "Administrative Aide II",
  "Administrative Aide III",
  "Administrative Aide IV",
  "Administrative Aide V",
  "Administrative Aide VI",
  "Administrative Assistant I",
  "Administrative Assistant II",
  "Administrative Assistant III",
  "Administrative Assistant IV",
  "Administrative Assistant V",
  "Administrative Assistant VI",
  "Agricultural and Biosystems Engineer I",
  "Agricultural and Biosystems Engineer II",
  "Agricultural and Biosystems Engineer III",
  "Agricultural and Biosystems Engineer IV",
  "Agricultural and Biosystems Engineer V",
  "Agricultural Technician I",
  "Agricultural Technician II",
  "Agricultural Technologist",
  "Associate Project Officer I",
  "Associate Project Officer II",
  "Agriculturist I",
  "Agriculturist II",
  "Chief Agriculturist",
  "Community Development Officer I",
  "Community Development Officer II",
  "Community Development Officer III",
  "Computer Programmer I",
  "Computer Programmer II",
  "Computer Programmer III",
  "Data Controller I",
  "Data Controller II",
  "Data Controller III",
  "Data Controller IV",
  "Development Management Officer I",
  "Development Management Officer II",
  "Development Management Officer III",
  "Development Management Officer IV",
  "Development Management Officer V",
  "Engineer I",
  "Engineer II",
  "Engineer III",
  "Engineer IV",
  "Engineer V",
  "Information Officer I",
  "Information Officer II",
  "Information Officer III",
  "Information Systems Analyst I",
  "Information Systems Analyst II",
  "Information Systems Analyst III",
  "Piece Worker Warehouseman",
  "Project Development Officer I",
  "Project Development Officer II",
  "Project Development Officer III",
  "Project Development Officer IV",
  "Project Development Officer V",
  "Project Evaluation Officer I",
  "Project Evaluation Officer II",
  "Project Evaluation Officer III",
  "Project Evaluation Officer IV",
  "Project Evaluation Officer V",
  "Senior Administrative Assistant I",
  "Senior Administrative Assistant II",
  "Senior Administrative Assistant III",
  "Senior Administrative Assistant IV",
  "Senior Agriculturist",
  "Supervising Agriculturist",
  "Warehouseman",
] as const;

export const accountDesignationOptions = [
  "Chief",
  "OIC APCO - ADN / SAAD",
  "APCO - ADS Chief",
  "APCO - SDN Chief",
  "OIC APCO - SDS",
  "OIC APCO - PDI",
  "APCO - ADN Alternate",
  "APCO - ADS Alternate",
  "APCO - SDN Alternate",
  "APCO - SDS Alternate",
  "APCO - PDI Alternate",
  "SAAD Program Focal Person",
  "NUPAP Coordinator / ELCAC",
  "ELCAC Focal Person",
  "OAP Coordinator",
  "Livestock Program Coordinator",
  "Corn & Soybean Program Coordinator",
  "FOD Alternate / Rice Program Coordinator",
  "HVCD/CFIDP/IPM Program Coordinator",
  "Alternate Rice Program / Alternate AGRISTAT",
  "Alternate Corn Program",
  "Alternate Livestock Program",
  "Alternate HVCD Program",
  "AGRISTAT/DRRM/AMIA Project Leader",
  "Halal Project Leader & GAD",
  "F2C2",
  "Alternate OAP / 4K Program Coordinator",
  "RSBSA & Extension and Partnership",
  "DRRM Procurement & Budget Officer",
  "DRRM Procurement & Planning Officer",
  "DRRM Early Response & Recovery",
  "DRRM Rehabilitation & Recovery",
  "AMIA - Report Officer",
  "AMIA - Planning Officer",
  "AMIA - Comm. Point Person",
  "AMIA - Machineries and Infrastructure",
  "AMIA - ACAP Developer",
  "AMIA - Procurement Officer",
  "AMIA - Clerical Support Staff",
  "AMIA - ADN Focal Person",
  "AMIA - ADS Focal Person",
  "AMIA - SDN Focal Person",
  "AMIA - SDS Focal Person",
  "AMIA - PDI Focal Person",
  "RCMO - Data Analyst",
  "RCMO - Team Lead",
  "PCMO - ADN",
  "PCMO - ADS",
  "PCMO - SDN",
  "PCMO - PDI",
  "PCMO - SDS",
] as const;

export function accountDesignation(value: unknown) {
  if (typeof value !== "string") return "";
  const cleaned = value.trim();
  if (!cleaned) return "";
  if (accountDesignationOptions.some((option) => option === cleaned)) return cleaned;
  const values = [...new Set(value.split(";").map((designation) => designation.trim()).filter(Boolean))];
  if (values.includes("Chief")) return "Chief";
  return values.find((designation) => accountDesignationOptions.some((option) => option === designation)) ?? cleaned;
}

export function hasAccountDesignation(value: unknown, designation: string) {
  return accountDesignation(value) === designation;
}

export const fieldOperationsCombinedAssignment = "AGRISTAT-AMIA-DRRM";

export const fieldOperationsAssignments = fieldOperationsUnitOptions;

export const regionalFieldOfficeAssignments = [
  ...tevDivisions,
  "Regional Executive Director",
  "RTD for Operations",
  "RTD for Research and Regulations",
].sort((first, second) => first.localeCompare(second));

export function assignmentsForOffice(office: string) {
  if (office === "Division") return [...new Set([...accountDivisionOptions, ...Object.values(unitsByDivision).flat()])];
  if (office === "Office of the Regional Executive Director") return executiveOfficeDivisionOptions;
  if (office === "Field Operations Division") return fieldOperationsAssignments;
  if (office === "Regional Field Office") return regionalFieldOfficeAssignments;
  return [] as const;
}

const divisionByLegacyAssignment: Record<string, string> = {
  AMIA: "Agribusiness and Marketing Assistance Division",
  AGRISTAT: "Planning, Monitoring and Evaluation Division",
  DRRM: "Field Operations Division",
};

export function accountDivisionForApproval(office: string, assignment: string, division = "") {
  if (division.trim()) return canonicalAdministrativeDivision(division.trim());
  return accountProfileSelection({ office, assignment, profileFieldsVersion: 3 }).division
    || divisionByLegacyAssignment[assignment.trim().toUpperCase()]
    || "";
}

export function accountTevDivision(office: string, assignment: string, division = ""): TevDivision | null {
  const selectedDivision = canonicalAdministrativeDivision(division.trim() || accountProfileSelection({ office, assignment, profileFieldsVersion: 3 }).division);
  if (selectedDivision === "Field Operations Division") return "Field Operations Division";
  return tevDivisions.includes(selectedDivision as TevDivision) ? selectedDivision as TevDivision : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function profileVersion(profile: AccountProfileFields) {
  return typeof profile.profileFieldsVersion === "number" ? profile.profileFieldsVersion : 0;
}

function rawAccountOffice(profile: AccountProfileFields) {
  const version = profileVersion(profile);
  if (version >= 2) return stringValue(profile.office) || stringValue(profile.projectProgram);
  return stringValue(profile.projectProgram) || stringValue(profile.unit) || stringValue(profile.office);
}

function fieldOperationsAssignmentAlias(value: string) {
  const normalized = value.trim().toUpperCase();
  const assignment = normalized.startsWith("FOD-") ? normalized.slice(4) : normalized;
  return ["AGRISTAT", "AMIA", "DRRM"].find((option) => option === assignment) ?? "";
}

function legacyAccountAssignment(profile: AccountProfileFields) {
  const version = profileVersion(profile);
  const assignment = version >= 3
    ? stringValue(profile.assignment)
    : version === 2
      ? stringValue(profile.projectProgram) || stringValue(profile.unit)
      : stringValue(profile.unit) || stringValue(profile.office) || stringValue(profile.projectProgram);
  if (assignment === fieldOperationsCombinedAssignment) return "";
  return fieldOperationsAssignmentAlias(assignment) || assignment || fieldOperationsAssignmentAlias(rawAccountOffice(profile));
}

function canonicalFieldOperationsOffice(value: string) {
  const normalized = value.trim();
  return normalized === "Field Operations Division (ILD)"
    || normalized.toUpperCase() === "AGRISTAT"
    || normalized.toUpperCase() === "AMIA"
    || normalized.toUpperCase() === "DRRM"
    || /^FOD-/i.test(normalized)
    ? "Field Operations Division"
    : normalized;
}

function canonicalAdministrativeDivision(value: string) {
  return value === "Administrative Division" ? "Administrative and Finance Division" : value;
}

function normalizeLegacyUnit(value: string) {
  const aliases: Record<string, string> = {
    GAD: "Gender and Development",
    "HVCDP Program": "HVCD Program",
    NUPAP: "NUPA Program",
    "Halal Project": "Halal Projects",
  };
  return aliases[value] ?? value;
}

function legacyProfileSelection(profile: AccountProfileFields): Pick<AccountProfileSelection, "office" | "division" | "unit"> {
  const rawOffice = canonicalAdministrativeDivision(canonicalFieldOperationsOffice(rawAccountOffice(profile)));
  const assignment = canonicalAdministrativeDivision(legacyAccountAssignment(profile));
  if (rawOffice === "Field Operations Division") {
    const unit = normalizeLegacyUnit(assignment);
    return {
      office: "Division",
      division: "Field Operations Division",
      unit: fieldOperationsUnitOptions.includes(unit as (typeof fieldOperationsUnitOptions)[number]) ? unit : "",
    };
  }
  if (rawOffice === "Regional Field Office") {
    const executiveDivision = assignment === "Regional Executive Director"
      ? "Office of the Regional Executive Director"
      : assignment;
    if (executiveOfficeDivisionOptions.includes(executiveDivision as (typeof executiveOfficeDivisionOptions)[number])) {
      return { office: "Office of the Regional Executive Director", division: executiveDivision, unit: executiveDivision };
    }
    if (accountDivisionOptions.includes(assignment as (typeof accountDivisionOptions)[number])) {
      return { office: "Division", division: assignment, unit: assignment };
    }
    const mappedDivision = divisionByLegacyAssignment[assignment.toUpperCase()];
    if (mappedDivision) return { office: "Division", division: mappedDivision, unit: assignment };
  }
  if (accountDivisionOptions.includes(rawOffice as (typeof accountDivisionOptions)[number])) {
    const possibleUnit = normalizeLegacyUnit(assignment);
    const allowedUnits = unitsForOfficeDivision("Division", rawOffice);
    return {
      office: "Division",
      division: rawOffice,
      unit: allowedUnits.includes(possibleUnit) ? possibleUnit : rawOffice,
    };
  }
  if (executiveOfficeDivisionOptions.includes(rawOffice as (typeof executiveOfficeDivisionOptions)[number])) {
    return { office: "Office of the Regional Executive Director", division: rawOffice, unit: rawOffice };
  }
  if (rawOffice === "Division") {
    const division = accountDivisionOptions.includes(assignment as (typeof accountDivisionOptions)[number])
      ? assignment
      : accountDivisionOptions.find((option) => unitsForOfficeDivision("Division", option).includes(assignment)) ?? "";
    return { office: "Division", division, unit: assignment };
  }
  if (rawOffice === "Office of the Regional Executive Director") {
    const division = executiveOfficeDivisionOptions.includes(assignment as (typeof executiveOfficeDivisionOptions)[number])
      ? assignment
      : "Office of the Regional Executive Director";
    return { office: rawOffice, division, unit: division };
  }
  return { office: "", division: "", unit: "" };
}

export function accountOffice(profile: AccountProfileFields) {
  return profileVersion(profile) >= 4
    ? canonicalAdministrativeDivision(stringValue(profile.office)) || null
    : legacyProfileSelection(profile).office || null;
}

export function accountDivision(profile: AccountProfileFields) {
  return profileVersion(profile) >= 4
    ? canonicalAdministrativeDivision(stringValue(profile.division))
    : legacyProfileSelection(profile).division;
}

export function accountUnit(profile: AccountProfileFields) {
  return profileVersion(profile) >= 4
    ? canonicalAdministrativeDivision(stringValue(profile.unit))
    : legacyProfileSelection(profile).unit;
}

export function accountAssignment(profile: AccountProfileFields) {
  return accountUnit(profile) || accountDivision(profile);
}

export function accountProfileSelection(profile: AccountProfileFields): AccountProfileSelection {
  const selected = profileVersion(profile) >= 4
    ? { office: canonicalAdministrativeDivision(stringValue(profile.office)), division: canonicalAdministrativeDivision(stringValue(profile.division)), unit: canonicalAdministrativeDivision(stringValue(profile.unit)) }
    : legacyProfileSelection(profile);
  if (!accountOfficeOptions.includes(selected.office as (typeof accountOfficeOptions)[number])) {
    return { office: "", division: "", unit: "", assignment: "" };
  }
  const validDivisions = divisionsForOffice(selected.office) as readonly string[];
  if (!validDivisions.includes(selected.division)) {
    return { office: selected.office, division: "", unit: "", assignment: "" };
  }
  const validUnits = unitsForOfficeDivision(selected.office, selected.division) as readonly string[];
  const unit = validUnits.includes(selected.unit) ? selected.unit : "";
  return { ...selected, unit, assignment: unit || selected.division };
}

export function migratedAccountProfileFields(profile: AccountProfileFields) {
  const selection = accountProfileSelection(profile);
  return {
    office: selection.office,
    division: selection.division,
    unit: selection.unit,
    assignment: selection.assignment,
    profileFieldsVersion: 4,
  };
}
