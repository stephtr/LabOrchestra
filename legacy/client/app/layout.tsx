import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import RootProvider from '@/components/provider';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
	title: 'LabOrchestra',
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
