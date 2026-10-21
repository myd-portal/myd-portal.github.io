export const SUPERADMIN_EMAIL = "rjamescute2@gmail.com";
export const ADMIN_EMAIL = "gerlieantipaso27@gmail.com";

export type AccountRole = "superadmin" | "admin" | "regular";
export type AccountStatus = "Pending" | "Approved" | "Disapproved";

export function accountRoleForEmail(email?: string | null): AccountRole {
  const normalizedEmail = email?.trim().toLowerCase();
  if (normalizedEmail === SUPERADMIN_EMAIL) return "superadmin";
  if (normalizedEmail === ADMIN_EMAIL) return "admin";
  return "regular";
}

export function normalizeAccountRole(role: unknown, email?: string | null): AccountRole {
  if (role === "superadmin" || role === "admin" || role === "regular") return role;
  if (role === "user") return "regular";
  return accountRoleForEmail(email);
}

export function normalizeAccountStatus(status: unknown): AccountStatus {
  if (status === undefined || status === null) return "Approved";
  if (status === "Approved" || status === "Pending" || status === "Disapproved") return status;
  return "Pending";
}

export function isSuperadminRole(role: unknown, email?: unknown): boolean {
  const normalizedRole = typeof role === "string" ? role.trim().toLowerCase() : "";
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  return normalizedRole === "superadmin" || normalizedEmail === SUPERADMIN_EMAIL;
}
