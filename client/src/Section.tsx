import { ReactNode } from 'react';

/** A section of a page: title, a line of explanation, and its content in a panel. */
export function Section({ title, description, actions, children, testId }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; testId?: string }) {
	return (
		<section data-testid={testId}>
			<div className="mb-2 flex flex-wrap items-end gap-x-4 gap-y-2">
				<div className="min-w-0 flex-1">
					<h2 className="font-semibold">{title}</h2>
					{description && <p className="text-sm text-muted">{description}</p>}
				</div>
				{actions}
			</div>
			<div className="overflow-x-auto rounded-lg border border-line bg-panel">{children}</div>
		</section>
	);
}

export const TABLE = 'w-full text-left text-sm [&_td]:px-4 [&_td]:py-1.5 [&_th]:px-4 [&_th]:py-2 [&_th]:text-xs [&_th]:font-normal [&_th]:text-muted [&_tbody_tr]:border-t [&_tbody_tr]:border-line';
