const fieldOperationsPermitOwnerUnits = new Set([
  "4K",
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
]);
const fieldOperationsProjectLeaderPermitOwnerUnits = new Set(["AGRISTAT", "AMIA", "DRRM"]);

function isRegularFieldOperationsPermitOwner(profile: {
  ownerRole?: unknown;
  ownerOffice?: unknown;
  ownerDivision?: unknown;
  ownerUnit?: unknown;
}, allowedUnits: Set<string>) {
  const ownerRole = typeof profile.ownerRole === "string" ? profile.ownerRole.trim().toLowerCase() : "";
  const isRegular = ownerRole === "regular" || ownerRole === "user";
  return isRegular
    && profile.ownerOffice === "Division"
    && profile.ownerDivision === "Field Operations Division"
    && typeof profile.ownerUnit === "string"
    && allowedUnits.has(profile.ownerUnit);
}

export function isFieldOperationsPermitOwner(profile: {
  ownerRole?: unknown;
  ownerOffice?: unknown;
  ownerDivision?: unknown;
  ownerUnit?: unknown;
}) {
  return isRegularFieldOperationsPermitOwner(profile, fieldOperationsPermitOwnerUnits);
}

export function isFieldOperationsProjectLeaderPermitOwner(profile: {
  ownerRole?: unknown;
  ownerOffice?: unknown;
  ownerDivision?: unknown;
  ownerUnit?: unknown;
}) {
  return isRegularFieldOperationsPermitOwner(profile, fieldOperationsProjectLeaderPermitOwnerUnits);
}

export function isFieldOperationsChiefPermitSignatory(profile: {
  accountRole: unknown;
  office: string;
  division: string;
  unit: string;
  designation: string;
}) {
  return profile.accountRole === "admin"
    && profile.office === "Division"
    && profile.division === "Field Operations Division"
    && profile.unit === "Field Operations Division"
    && profile.designation === "Chief";
}

export function isFieldOperationsProjectLeaderPermitSignatory(profile: {
  accountRole: unknown;
  office: string;
  division: string;
  unit: string;
  designation: string;
}) {
  return profile.accountRole === "admin"
    && profile.office === "Division"
    && profile.division === "Field Operations Division"
    && profile.unit === "Field Operations Division"
    && profile.designation === "AGRISTAT/DRRM/AMIA Project Leader";
}
