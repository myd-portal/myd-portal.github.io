import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./mobile.css";
import "./animations.css";
import "./navigation.css";
import "./permit-standalone.css";
import "./permit-slip-form.css";
import "./special-order-form.css";
import SystemBackground from "./SystemBackground";
import NativePlatformBridge from "./NativePlatformBridge";

export const metadata: Metadata = {
  metadataBase: new URL("https://myd-portal.github.io"),
  title: "My Desk",
  description: "where your docs meet automation",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: { capable: true, title: "My Desk", statusBarStyle: "default" },
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

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#d85532",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body suppressHydrationWarning><SystemBackground /><NativePlatformBridge />{children}</body></html>;
}
