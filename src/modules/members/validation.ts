import { z } from "zod";
import { toLatinDigits } from "@/lib/digits";
import { normalizeBdPhone } from "@/lib/phone";
import { normalizeNid } from "./nid";

/**
 * Admission form input. Messages are error codes, translated by the page
 * (members.errors.*), so one schema serves both languages.
 */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "too_long")
    .optional()
    .transform((v) => (v ? v : undefined));

const optionalDate = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? toLatinDigits(v) : undefined))
  .pipe(z.iso.date("invalid_date").optional());

export const admitMemberInput = z
  .object({
    nameEn: optionalText(120),
    nameBn: optionalText(120),
    guardianRelation: z.enum(["father", "husband"]).optional(),
    guardianNameEn: optionalText(120),
    guardianNameBn: optionalText(120),
    phone: z
      .string()
      .transform((v, ctx) => {
        const phone = normalizeBdPhone(v);
        if (!phone) ctx.addIssue({ code: "custom", message: "invalid_phone" });
        return phone ?? "";
      }),
    nid: z
      .string()
      .optional()
      .transform((v, ctx) => {
        if (!v?.trim()) return undefined;
        const nid = normalizeNid(v);
        if (!nid) ctx.addIssue({ code: "custom", message: "invalid_nid" });
        return nid ?? undefined;
      }),
    dateOfBirth: optionalDate,
    address: optionalText(500),
    commLocale: z.enum(["en", "bn"]).optional(),
    admissionDate: optionalDate,
    branchId: z.uuid().optional(),
  });

export type AdmitMemberInput = z.input<typeof admitMemberInput>;
export type AdmitMemberData = z.output<typeof admitMemberInput>;

export type MemberErrorCode =
  | "name_required"
  | "guardian_name_required"
  | "invalid_phone"
  | "invalid_nid"
  | "duplicate_nid"
  | "invalid_date"
  | "admission_after_business_date"
  | "dob_after_admission"
  | "too_long"
  | "invalid";

export type MemberFieldErrors = Partial<Record<keyof AdmitMemberData, MemberErrorCode>>;

const KNOWN = new Set<string>([
  "name_required",
  "guardian_name_required",
  "invalid_phone",
  "invalid_nid",
  "invalid_date",
  "dob_after_admission",
  "too_long",
]);

/**
 * Checks the whole form and reports every problem at once, one per field.
 * Rules that span fields run here rather than in a zod refinement, which
 * would be skipped whenever any single field is already invalid.
 */
export function validateAdmission(
  raw: AdmitMemberInput,
): { ok: true; data: AdmitMemberData } | { ok: false; errors: MemberFieldErrors } {
  const errors: MemberFieldErrors = {};
  const add = (field: keyof AdmitMemberData, code: MemberErrorCode) => {
    if (!errors[field]) errors[field] = code;
  };

  const parsed = admitMemberInput.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as keyof AdmitMemberData | undefined;
      if (field) add(field, (KNOWN.has(issue.message) ? issue.message : "invalid") as MemberErrorCode);
    }
  }

  const filled = (v: string | undefined) => !!v?.trim();
  if (!filled(raw.nameEn) && !filled(raw.nameBn)) add("nameEn", "name_required");
  if (raw.guardianRelation && !filled(raw.guardianNameEn) && !filled(raw.guardianNameBn)) {
    add("guardianNameEn", "guardian_name_required");
  }
  if (parsed.success) {
    const { dateOfBirth, admissionDate } = parsed.data;
    if (dateOfBirth && admissionDate && dateOfBirth >= admissionDate) add("dateOfBirth", "dob_after_admission");
  }

  return parsed.success && Object.keys(errors).length === 0 ? { ok: true, data: parsed.data } : { ok: false, errors };
}
