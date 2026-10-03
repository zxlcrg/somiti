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
