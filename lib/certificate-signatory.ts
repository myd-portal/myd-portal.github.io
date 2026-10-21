import { isSuperadminRole } from "@/lib/user-roles";

export const fieldOperationsChiefAppearanceUnits = [
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
] as const;

export const fieldOperationsProjectLeaderAppearanceUnits = ["AGRISTAT", "AMIA", "DRRM"] as const;

export type CertificateAppearanceSignatory = {
  designation: "Chief" | "AGRISTAT/DRRM/AMIA Project Leader";
  signatureAsset: "field_operations_division_chief_signature.png" | "agristat_and_drrm_focal_persons_amia_project_leader.png";
};

export function certificateAppearanceSignatoryForOwner(office: string, division: string, unit: string): CertificateAppearanceSignatory | null {
  if (office !== "Division" || division !== "Field Operations Division") return null;
  if (fieldOperationsProjectLeaderAppearanceUnits.includes(unit as (typeof fieldOperationsProjectLeaderAppearanceUnits)[number])) {
    return {
      designation: "AGRISTAT/DRRM/AMIA Project Leader",
      signatureAsset: "agristat_and_drrm_focal_persons_amia_project_leader.png",
    };
  }
  if (fieldOperationsChiefAppearanceUnits.includes(unit as (typeof fieldOperationsChiefAppearanceUnits)[number])) {
    return { designation: "Chief", signatureAsset: "field_operations_division_chief_signature.png" };
  }
  return null;
}

export function isFieldOperationsAppearanceApprover(profile: {
  accountRole?: unknown;
  email?: unknown;
  office?: unknown;
  division?: unknown;
  unit?: unknown;
  designation?: unknown;
}) {
  return !isSuperadminRole(profile.accountRole, profile.email)
    && profile.accountRole === "admin"
    && profile.office === "Division"
    && profile.division === "Field Operations Division"
    && profile.unit === "Field Operations Division"
    && (profile.designation === "Chief" || profile.designation === "AGRISTAT/DRRM/AMIA Project Leader");
}

export function fieldOperationsAppearanceUnitsForApprover(designation: string) {
  if (designation === "Chief") return fieldOperationsChiefAppearanceUnits;
  if (designation === "AGRISTAT/DRRM/AMIA Project Leader") return fieldOperationsProjectLeaderAppearanceUnits;
  return [] as const;
}
