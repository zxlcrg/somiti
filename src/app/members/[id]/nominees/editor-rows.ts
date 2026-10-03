/** One nominee row as the editor holds it: everything as typed, shares in percent. */
export interface EditorRow {
  key: string;
  id?: string;
  nameEn: string;
  nameBn: string;
  relation: string;
  phone: string;
  nid: string;
  /** Last four digits of an NID already on file for this nominee. */
  nidLast4?: string | null;
  dateOfBirth: string;
  minorGuardianNameEn: string;
  minorGuardianNameBn: string;
  share: string;
}

export type EditorField = Exclude<keyof EditorRow, "key" | "id" | "nidLast4">;

let counter = 0;

export function blankRow(share = ""): EditorRow {
  counter += 1;
  return {
    key: `new-${Date.now().toString(36)}-${counter}`,
    nameEn: "",
    nameBn: "",
    relation: "",
    phone: "",
    nid: "",
    dateOfBirth: "",
    minorGuardianNameEn: "",
    minorGuardianNameBn: "",
    share,
  };
}
