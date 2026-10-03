import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser, LAST_SLUG_COOKIE } from "../auth";
import { SignInForm } from "./sign-in-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("signIn") };
}

export default async function SignInPage() {
  if (await getCurrentUser()) redirect("/dashboard");
  const t = await getTranslations("auth");
  const lastSlug = (await cookies()).get(LAST_SLUG_COOKIE)?.value ?? "";
  const points = [t("artPoints.one"), t("artPoints.two"), t("artPoints.three")];

  return (
    <div className="auth">
      <aside className="auth-art" aria-hidden="true">
        <div className="coins">
          <span>৳</span>
          <span>৳</span>
          <span>৳</span>
        </div>
        <h2>{t("artTitle")}</h2>
        <ul>
          {points.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <div className="ledger-card">
          <div>
            <span>Dr</span>
            <i style={{ width: "72%" }} />
          </div>
          <div>
            <span>Cr</span>
            <i style={{ width: "72%" }} />
          </div>
          <b>✓</b>
        </div>
      </aside>
      <section className="auth-panel">
        <h1>{t("title")}</h1>
        <p className="muted">{t("subtitle")}</p>
        <SignInForm initialSlug={lastSlug} devHint={process.env.NODE_ENV !== "production"} />
      </section>
    </div>
  );
}
