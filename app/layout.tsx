import type { Metadata } from "next"
import type React from "react"
import { ThemeProvider } from "@/components/theme-provider"
import { QueryProvider } from "@/components/query-provider"
import { CreditPriceProvider } from "@/components/credit-price-provider"
import { APP_TITLE, LOGO_SRC } from "@/lib/constants"
import "./globals.css"

export const metadata: Metadata = {
  title: APP_TITLE,
  description:
    "One place to see Snowflake AI and platform credit consumption, and to set the quotas, budgets and alerts that govern it.",
  icons: { icon: LOGO_SRC },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider>
          <QueryProvider>
            {/* The header needs the credit price and lives inside the page, so
                the provider wraps the whole tree rather than sitting below it. */}
            <CreditPriceProvider>{children}</CreditPriceProvider>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
