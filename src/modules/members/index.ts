export { normalizeNid } from "./nid";
export { canManageMembers, canViewMembers } from "./permissions";
export {
  admitMember,
  getMember,
  listMembers,
  memberStats,
  nextMemberNo,
  type AdmitResult,
  type MemberQuery,
  type MemberStats,
  type MemberStatus,
  type MemberView,
} from "./service";
export type { AdmitMemberInput, MemberErrorCode, MemberFieldErrors } from "./validation";
export {
  ADULT_AGE,
  equalShares,
  listNominees,
  MAX_NOMINEES,
  NOMINEE_RELATIONS,
  parseSharePercent,
  saveNominees,
  type NomineeErrorCode,
  type NomineeInput,
  type NomineeRelation,
  type NomineeRowErrors,
  type NomineeView,
  type SaveNomineesResult,
} from "./nominees";
export {
  detectImageType,
  getMemberPhoto,
  MAX_PHOTO_BYTES,
  removeMemberPhoto,
  setMemberPhoto,
  type PhotoType,
  type SetPhotoResult,
} from "./photos";
