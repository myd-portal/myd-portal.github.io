import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { isSuperadminRole } from "@/lib/user-roles";
import { accountDesignation, accountProfileSelection, fieldOperationsCombinedAssignment } from "@/lib/account-profile";

export type PersonnelEntry = { userId: string; name: string; position: string; office: string; division: string; unit: string; accountRole?: string; accountStatus?: string };
export type PermitAdminSignatory = { userId: string; name: string; position: string; office: string; division: string; unit: string; assignment: string; designation: string; fullSignatureURL: string };

export function isApprovedAdminAccount(accountRole: unknown, accountStatus: unknown, email?: unknown) {
  return accountRole === "admin" && !isSuperadminRole(accountRole, email) && (accountStatus === undefined || accountStatus === null || accountStatus === "Approved");
}

export function personnelDisplayName(person: Pick<PersonnelEntry, "name">) {
  return person.name;
}

export function personnelMatchesAccountScope(
  candidateOffice: string,
  candidateAssignment: string,
  office: string,
  assignment: string,
  options: { includeAdminAccounts?: boolean; accountRole?: unknown; accountStatus?: unknown; division?: string; candidateDivision?: string } = {},
) {
  if (options.includeAdminAccounts && isApprovedAdminAccount(options.accountRole, options.accountStatus)) return true;
  const scope = options.division
    ? accountProfileSelection({ office, division: options.division, unit: assignment, profileFieldsVersion: 4 })
    : accountProfileSelection({ office, assignment, profileFieldsVersion: 3 });
  const candidate = options.candidateDivision
    ? accountProfileSelection({ office: candidateOffice, division: options.candidateDivision, unit: candidateAssignment, profileFieldsVersion: 4 })
    : accountProfileSelection({ office: candidateOffice, assignment: candidateAssignment, profileFieldsVersion: 3 });
  if (!scope.office || candidate.office !== scope.office) return false;
  return Boolean(scope.division && candidate.division === scope.division && scope.assignment && candidate.assignment === scope.assignment);
}

export function filterPersonnelForAccount(entries: PersonnelEntry[], office: string, assignment: string, options: { includeAdminAccounts?: boolean; division?: string } = {}) {
  return entries.filter((person) => personnelMatchesAccountScope(person.office, person.unit, office, assignment, {
    ...options,
    candidateDivision: person.division,
    accountRole: person.accountRole,
    accountStatus: person.accountStatus,
  }));
}

export function filterPersonnelForDivision(entries: PersonnelEntry[], office: string, division: string) {
  const selectedOffice = office.trim();
  const selectedDivision = division.trim();
  if (!selectedOffice || !selectedDivision) return [];
  return entries.filter((person) => person.office === selectedOffice && person.division === selectedDivision);
}

const personnelCacheDurationMs = 60_000;
const cachedPersonnel = new Map<string, { entries: PersonnelEntry[]; expiresAt: number }>();
const personnelRequests = new Map<string, Promise<PersonnelEntry[]>>();
let cachedPermitAdminSignatories: { entries: PermitAdminSignatory[]; expiresAt: number } | null = null;
let permitAdminSignatoriesRequest: Promise<PermitAdminSignatory[]> | null = null;

export async function loadPermitAdminSignatories(): Promise<PermitAdminSignatory[]> {
  if (!db) throw new Error("Firebase is not configured.");
  if (cachedPermitAdminSignatories && cachedPermitAdminSignatories.expiresAt > Date.now()) {
    return cachedPermitAdminSignatories.entries;
  }
  const pendingRequest = permitAdminSignatoriesRequest;
  if (pendingRequest) return pendingRequest;
  const firestore = db;
  const request = getDocs(collection(firestore, "users")).then((snapshot) => {
    const entries = snapshot.docs.flatMap((item) => {
      const data = item.data();
      if (isSuperadminRole(data.accountRole, data.email) || data.accountRole !== "admin" || (data.accountStatus !== undefined && data.accountStatus !== "Approved")) return [];
      const profile = accountProfileSelection(data);
      const hasCombinedFieldOperationsAssignment = [data.assignment, data.projectProgram, data.unit]
        .some((value) => typeof value === "string" && value.trim() === fieldOperationsCombinedAssignment);
      const name = typeof data.name === "string" ? data.name.trim() : "";
      if (!name || !profile.office) return [];
      return [{
        userId: item.id,
        name,
        position: typeof data.position === "string" ? data.position.trim() : "",
        office: profile.office,
        division: profile.division,
        unit: profile.unit,
        assignment: hasCombinedFieldOperationsAssignment ? fieldOperationsCombinedAssignment : profile.assignment,
        designation: accountDesignation(data.designation),
        fullSignatureURL: typeof data.fullSignatureURL === "string" ? data.fullSignatureURL.trim() : "",
      }];
    }).sort((first, second) => first.name.localeCompare(second.name, "en", { sensitivity: "base" })
      || first.userId.localeCompare(second.userId));
    cachedPermitAdminSignatories = { entries, expiresAt: Date.now() + personnelCacheDurationMs };
    return entries;
  }).finally(() => {
    permitAdminSignatoriesRequest = null;
  });
  permitAdminSignatoriesRequest = request;
  return request;
}

// Personnel dropdowns are built from registered user accounts (users collection).
export async function loadPersonnel(options: { deduplicateByName?: boolean } = {}): Promise<PersonnelEntry[]> {
  if (!db) throw new Error("Firebase is not configured.");
  const deduplicateByName = options.deduplicateByName ?? true;
  const cacheKey = String(deduplicateByName);
  const cached = cachedPersonnel.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.entries;
  let personnelRequest = personnelRequests.get(cacheKey);
  if (!personnelRequest) {
    const firestore = db;
    personnelRequest = getDocs(collection(firestore, "users")).then((snapshot) => {
      const entries = snapshot.docs.filter((item) => !isSuperadminRole(item.data().accountRole, item.data().email)).map((item) => {
        const data = item.data();
        const profile = accountProfileSelection(data);
        return {
          userId: item.id,
          name: typeof data.name === "string" ? data.name.trim() : "",
          position: typeof data.position === "string" ? data.position.trim() : "",
          office: profile.office,
          division: profile.division,
          unit: profile.unit || profile.assignment,
          accountRole: typeof data.accountRole === "string" ? data.accountRole : undefined,
          accountStatus: typeof data.accountStatus === "string" ? data.accountStatus : undefined,
        };
      }).filter((person) => person.name);
      const unique = new Map<string, PersonnelEntry>();
      const adminAccounts: PersonnelEntry[] = [];
      for (const entry of entries) {
        if (isApprovedAdminAccount(entry.accountRole, entry.accountStatus)) {
          adminAccounts.push(entry);
          continue;
        }
        const key = entry.name.toLowerCase().replace(/\s+/g, " ");
        const existing = unique.get(key);
        if (!existing || (!existing.position && entry.position) || (!existing.office && entry.office) || (!existing.unit && entry.unit)) unique.set(key, entry);
      }
      const result = (deduplicateByName ? [...unique.values(), ...adminAccounts] : entries).sort((first, second) => first.name.localeCompare(second.name, "en", { sensitivity: "base" })
        || first.userId.localeCompare(second.userId));
      cachedPersonnel.set(cacheKey, { entries: result, expiresAt: Date.now() + personnelCacheDurationMs });
      return result;
    }).finally(() => {
      personnelRequests.delete(cacheKey);
    });
    personnelRequests.set(cacheKey, personnelRequest);
  }
  return personnelRequest;
}
