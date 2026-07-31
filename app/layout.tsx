import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "NQ Cockpit",
  description: "Personal trading discipline instrumentation",
  manifest: "/manifest.json",
  icons: {
    icon: "/favicon-32.png",
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    // Hides Safari's browser chrome when launched from the Home Screen icon,
    // so it opens full-screen like a real app instead of a browser tab.
    capable: true,
    statusBarStyle: "black-translucent",
    title: "NQ Cockpit",
  },
};

export const viewport: Viewport = {
  // No missing viewport tag before this — meant the app rendered at
  // desktop width and got shrunk to fit, instead of laying out properly at
  // phone width. Zoom is deliberately left enabled (unlike a typical "app
  // feel" setup) since this app is full of dense numeric tables that are
  // genuinely easier to read zoomed in on a phone.
  width: "device-width",
  initialScale: 1,
  themeColor: "#0B1220",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
