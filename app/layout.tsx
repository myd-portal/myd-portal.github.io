import type { Metadata } from "next";
import "./globals.css";
import "./animations.css";
import "./navigation.css";
import "./permit-standalone.css";
import "./permit-slip-form.css";
import "./special-order-form.css";
import SystemBackground from "./SystemBackground";

export const metadata: Metadata = {
  metadataBase: new URL("https://myd-portal.github.io"),
  title: "My Desk",
  description: "where your docs meet automation",
  icons: { icon: "/my%20desk%20logo.png" },
  openGraph: {
    title: "My Desk",
    description: "where your docs meet automation",
    url: "/",
    siteName: "My Desk",
    images: [{ url: "/og.png", alt: "My Desk" }],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "My Desk",
    description: "where your docs meet automation",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body suppressHydrationWarning><SystemBackground />{children}</body></html>;
}
