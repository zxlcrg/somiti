import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { LanguageSwitcher } from "./language-switcher";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("app");
  return { title: t("name"), description: t("tagline") };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const t = await getTranslations("app");
  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider>
          <header className="topbar">
            <strong className="brand">
              <span className="logo" aria-hidden="true">
                ৳
              </span>
              {t("name")}
            </strong>
            <LanguageSwitcher />
          </header>
          <main>{children}</main>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
