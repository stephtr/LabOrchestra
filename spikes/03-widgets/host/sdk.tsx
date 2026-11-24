import { createContext, useContext, type ReactNode } from 'react';
import { Slider as S, Popover as P } from 'radix-ui';
export const DeviceContext = createContext<any>(null);
export function useDevice(id: string) { return useContext(DeviceContext)[id]; }
export function Button(p: any) { return <button {...p} className={`rounded px-3 py-1 bg-brand text-white ${p.className ?? ''}`} />; }
export function Slider(p: any) { return <S.Root {...p} className="relative flex w-40 h-4 items-center"><S.Track className="relative grow h-1 bg-gray-300"><S.Range className="absolute h-full bg-brand" /></S.Track><S.Thumb className="block size-4 rounded-full bg-brand" /></S.Root>; }
export function Popover({ trigger, children }: { trigger: ReactNode; children: ReactNode }) { return <P.Root><P.Trigger asChild>{trigger}</P.Trigger><P.Portal><P.Content id="pop" className="bg-white p-3 shadow">{children}</P.Content></P.Portal></P.Root>; }
