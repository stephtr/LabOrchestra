import { createContext, ReactNode } from 'react';

/** Lets a widget show the small widgets that the user put into it (its "dock"): the dashboard provides it, the widget calls it with its own
 *  instance id where it has room (the lower left of the oscilloscope) and gets nothing outside a dashboard. */
export type Dock = { render: (instanceId: string) => ReactNode; /** How many small widgets the widget holds (it makes room for them). */ count: (instanceId: string) => number };
export const DockContext = createContext<Dock | null>(null);
