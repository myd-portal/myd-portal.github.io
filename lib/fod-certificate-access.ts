const FOD_CERTIFICATE_UNITS = new Set(["AGRISTAT", "AMIA", "DRRM"]);

export function canCreateFodCertificateTemplates(profile: {
  accountRole?: string | null;
  division?: string | null;
  unit?: string | null;
}) {
  const role = profile.accountRole?.trim().toLowerCase();
  if (role === "regular") return FOD_CERTIFICATE_UNITS.has(profile.unit?.trim() ?? "");
  return role === "admin" && profile.division?.trim() === "Field Operations Division";
}
