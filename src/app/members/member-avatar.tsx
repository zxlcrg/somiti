import type { Locale } from "@/i18n/config";
import { initial, type BilingualName } from "@/lib/names";

/** A hue per member number, so a member keeps their colour everywhere. Starts at teal. */
export function memberHue(memberNo: number): number {
  return (170 + memberNo * 47) % 360;
}

/** A coloured initial in the member's hue. */
export function MemberAvatar({
  member,
  locale,
  size = "md",
}: {
  member: BilingualName & { memberNo: number };
  locale: Locale;
  size?: "md" | "lg";
}) {
  const hue = memberHue(member.memberNo);
  return (
    <span
      className={`member-avatar ${size}`}
      style={{ "--h": hue } as React.CSSProperties}
      aria-hidden="true"
    >
      {initial(member, locale)}
    </span>
  );
}
