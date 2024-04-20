import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import RootProvider from '@/components/provider';

import { config } from '@fortawesome/fontawesome-svg-core';
// eslint-disable-next-line import/newline-after-import
import '@fortawesome/fontawesome-svg-core/styles.css';
config.autoAddCss = false;

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Experiment-Control",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full bg-zinc-100 dark:bg-slate-600 dark">
      <body className={`${inter.className} h-full dark:bg-slate-950`}>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
