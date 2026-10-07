export { normalizeNid } from "./nid";
export { canManageMembers, canRecordPayments, canViewMembers } from "./permissions";
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
export {
  buyShares,
  MAX_SHARES_PER_PURCHASE,
  parseShareCount,
  PAYMENT_METHODS,
  shareHolding,
  sharePrice,
  type BuySharesError,
  type BuySharesInput,
  type BuySharesResult,
  type PaymentMethod,
  type ShareHolding,
  type ShareTxnView,
} from "./shares";
