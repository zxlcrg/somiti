import type { Locale } from "@/i18n/config";
import { initial, type BilingualName } from "@/lib/names";

/** A hue per member number, so a member keeps their colour everywhere. Starts at teal. */
export function memberHue(memberNo: number): number {
  return (170 + memberNo * 47) % 360;
}

/** Where a member's photo is served; the version makes a new photo a new URL. */
export function memberPhotoUrl(memberId: string, version: string): string {
  return `/members/${memberId}/photo?v=${version}`;
}

/** The member's photo, or a coloured initial in the member's hue. */
export function MemberAvatar({
  member,
  locale,
  size = "md",
}: {
  member: BilingualName & { memberNo: number; id?: string; photoVersion?: string | null };
  locale: Locale;
  size?: "md" | "lg";
}) {
  const hue = memberHue(member.memberNo);
  const photo = member.id && member.photoVersion ? memberPhotoUrl(member.id, member.photoVersion) : null;
  return (
    <span
      className={`member-avatar ${size}${photo ? " has-photo" : ""}`}
      style={{ "--h": hue } as React.CSSProperties}
      aria-hidden="true"
    >
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element -- private, per-session image; next/image would proxy and cache it
        <img src={photo} alt="" loading="lazy" decoding="async" />
      ) : (
        initial(member, locale)
      )}
    </span>
  );
}
