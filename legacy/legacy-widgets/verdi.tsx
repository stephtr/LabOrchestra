'use client';

import React from 'react';
import {
	Button,
	Input,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Spinner,
} from '@heroui/react';
import {
	IconAlertTriangle,
	IconPower,
	IconSnowflake,
	IconSun,
} from '@tabler/icons-react';
import { useControl } from '@/lib/controlHub';
import { ConnectionToggleButton } from '@/components/reconnectButton';

// Gerät `verdi` (server/Devices/Verdi.py): Laser + Chiller + Sense-Upload
interface VerdiState {
	connected: boolean;
	busy: boolean;
	step: string | null;
	message: string | null;
	messageError: boolean;
	warning: string | null;
	maxPower: number;
	laser: {
		reachable: boolean;
		port: string;
		status: 'ON' | 'OFF' | 'FAULT' | string | null;
		power: number | null;
		setPower: number | null;
		shutterOpen: boolean | null;
		keyEnabled: boolean | null;
		error: string | null;
	};
	chiller: {
		reachable: boolean;
		port: string;
		mode: string | null;
		running: boolean | null;
		temperature: number | null;
		setpoint: number | null;
		alarms: string[];
		error: string | null;
	};
	sense: { ok: boolean | null; lastUpload: number | null; error: string | null };
}

function fmt(value: number | null | undefined, digits: number, unit: string) {
	return value === null || value === undefined ? '–' : `${value.toFixed(digits)} ${unit}`;
}

function ago(ms: number | null) {
	if (!ms) return '–';
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	return s < 120 ? `vor ${s} s` : `vor ${Math.round(s / 60)} min`;
}

export function VerdiButton() {
	const { isConnected, state, action } = useControl<VerdiState>('verdi');
	const [isOpen, setIsOpen] = React.useState(false);
	const [powerText, setPowerText] = React.useState('');
	const [localError, setLocalError] = React.useState<string | null>(null);

	const laser = state?.laser;
	const chiller = state?.chiller;
	const isOn = laser?.status === 'ON';
	const isFault = laser?.status === 'FAULT';
	const shutterOpen = laser?.shutterOpen === true;
	const busy = state?.busy === true;
	const deviceConnected = state?.connected !== false;
	const canAct = isConnected && deviceConnected && laser?.reachable === true;

	const run = (name: string, ...args: unknown[]) => {
		setLocalError(null);
		Promise.resolve((action as (n: string, ...a: unknown[]) => unknown)(name, ...args)).catch((e) =>
			setLocalError(e instanceof Error ? e.message : String(e)),
		);
	};

	const powerOn = () => {
		if (window.confirm('Verdi einschalten?\n\nChiller startet, danach geht der Laser an (Shutter bleibt zu).\nSchutzbrille und Strahlengang prüfen.'))
			run('power_on');
	};
	const shutterOpenAction = () => {
		if (window.confirm('Shutter öffnen? Der Strahl verlässt den Laser.\n\nSchutzbrille und Strahlengang prüfen.'))
			run('shutter_open');
	};
	const setPower = () => {
		const watt = Number(powerText.replace(',', '.'));
		const max = state?.maxPower ?? 10;
		if (!Number.isFinite(watt) || watt < 0 || watt > max) {
			setLocalError(`Leistung zwischen 0 und ${max} W eingeben.`);
			return;
		}
		const current = laser?.setPower;
		if ((current === null || current === undefined || watt > current) &&
			!window.confirm(`Leistung ${current === null || current === undefined ? 'unbekannt' : `von ${current.toFixed(3)} W`} auf ${watt} W setzen?`))
			return;
		run('set_power', watt);
	};

	// Knopf in der Seitenleiste: Zustand auf einen Blick
	let color: 'default' | 'success' | 'warning' | 'danger' = 'default';
	let label = 'Verdi aus';
	if (!deviceConnected || !laser?.reachable) {
		color = 'warning';
		label = 'Verdi ?';
	} else if (isFault || state?.warning) {
		color = 'danger';
		label = isFault ? 'Verdi FAULT' : 'Verdi !';
	} else if (busy) {
		label = 'Verdi …';
	} else if (isOn) {
		color = shutterOpen ? 'warning' : 'success';
		label = `${fmt(laser?.power, 2, 'W')}${shutterOpen ? ' offen' : ''}`;
	}

	const message = localError ?? state?.message;
	const messageIsError = localError !== null || state?.messageError;

	return (
		<Popover
			backdrop="transparent"
			placement="right-end"
			showArrow
			shouldCloseOnBlur={false}
			shouldCloseOnInteractOutside={() => false}
			shouldCloseOnScroll={false}
			isOpen={isOpen}
			onOpenChange={setIsOpen}
		>
			<PopoverTrigger>
				<Button
					variant="flat"
					color={color}
					startContent={busy ? <Spinner size="sm" color="current" /> : <IconSun size="1.2em" />}
					className="w-full min-h-12 h-auto px-2 py-1 tabular-nums justify-start"
				>
					{label}
				</Button>
			</PopoverTrigger>
			<PopoverContent className="grid gap-3 p-3 w-[23rem]">
				<div className="flex items-center justify-between">
					<span className="font-bold">Verdi 532 nm + Chiller</span>
					<ConnectionToggleButton
						action={action as (name: string) => unknown}
						isDeviceConnected={deviceConnected}
						isDisabled={!isConnected}
						deviceName="Verdi"
						className="h-9"
					/>
				</div>

				<div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-small tabular-nums">
					<span className="text-default-500">Laser</span>
					<span className={isFault ? 'text-danger font-bold' : isOn ? 'text-success font-bold' : ''}>
						{laser?.reachable ? laser.status : laser?.error ?? '–'}
					</span>
					<span className="text-default-500">Leistung</span>
					<span>
						{fmt(laser?.power, 3, 'W')} <span className="text-default-400">(Soll {fmt(laser?.setPower, 3, 'W')})</span>
					</span>
					<span className="text-default-500">Shutter</span>
					<span className={shutterOpen ? 'text-warning font-bold' : ''}>
						{laser?.shutterOpen === null || laser?.shutterOpen === undefined ? '–' : shutterOpen ? 'offen' : 'zu'}
					</span>
					<span className="text-default-500">Schlüssel</span>
					<span className={laser?.keyEnabled === false ? 'text-warning' : ''}>
						{laser?.keyEnabled === null || laser?.keyEnabled === undefined ? '–' : laser.keyEnabled ? 'enable' : 'off'}
					</span>
					<span className="text-default-500 flex items-center gap-1">
						<IconSnowflake size="1em" /> Chiller
					</span>
					<span className={chiller?.alarms?.length ? 'text-danger' : chiller?.running ? 'text-success' : ''}>
						{chiller?.reachable ? chiller.mode : chiller?.error ?? '–'}
						{chiller?.alarms?.length ? ` – Alarm: ${chiller.alarms.join(', ')}` : ''}
					</span>
					<span className="text-default-500">Kühlwasser</span>
					<span>
						{fmt(chiller?.temperature, 2, '°C')} <span className="text-default-400">(Soll {fmt(chiller?.setpoint, 1, '°C')})</span>
					</span>
					<span className="text-default-500">Sense</span>
					<span className={state?.sense?.ok === false ? 'text-warning' : 'text-default-500'}>
						{state?.sense?.ok === false ? state.sense.error : `hochgeladen ${ago(state?.sense?.lastUpload ?? null)}`}
					</span>
				</div>

				{busy && (
					<div className="flex items-center gap-2 text-small">
						<Spinner size="sm" /> {state?.step ?? 'läuft …'}
					</div>
				)}
				{state?.warning && (
					<div className="flex items-center gap-2 text-small font-bold text-danger">
						<IconAlertTriangle size="1.1em" /> {state.warning}
					</div>
				)}
				{message && (
					<div className={`text-small ${messageIsError ? 'text-danger' : 'text-success'}`}>{message}</div>
				)}

				<div className="grid grid-cols-2 gap-2">
					<Button
						color="success"
						startContent={<IconPower size="1.1em" />}
						isDisabled={!canAct || busy || isOn}
						onPress={powerOn}
					>
						Einschalten
					</Button>
					<Button
						color="danger"
						startContent={<IconPower size="1.1em" />}
						isDisabled={!isConnected || !deviceConnected}
						onPress={() => run('power_off')}
					>
						Ausschalten
					</Button>
					<Button color="warning" variant="flat" isDisabled={!canAct || !isOn || shutterOpen} onPress={shutterOpenAction}>
						Shutter öffnen
					</Button>
					<Button variant="flat" isDisabled={!canAct || !shutterOpen} onPress={() => run('shutter_close')}>
						Shutter schließen
					</Button>
				</div>

				<div className="flex items-center gap-2">
					<Input
						size="sm"
						label={`Leistung (max ${state?.maxPower ?? 10} W)`}
						placeholder={laser?.setPower?.toFixed(3) ?? ''}
						value={powerText}
						inputMode="decimal"
						onValueChange={setPowerText}
						onKeyDown={(event) => {
							if (event.key === 'Enter') setPower();
						}}
						endContent={<span className="text-small text-default-400">W</span>}
						isDisabled={!canAct}
					/>
					<Button className="h-12" isDisabled={!canAct || powerText.trim() === ''} onPress={setPower}>
						Setzen
					</Button>
				</div>

				<div className="flex items-center gap-2 text-small text-default-500">
					<IconSnowflake size="1.1em" /> Chiller allein:
					<Button size="sm" variant="flat" isDisabled={!isConnected || !deviceConnected || busy} onPress={() => run('chiller_start')}>
						Start
					</Button>
					<Button
						size="sm"
						variant="flat"
						isDisabled={!isConnected || !deviceConnected || busy || isOn}
						title={isOn ? 'Erst den Verdi ausschalten' : undefined}
						onPress={() => run('chiller_standby')}
					>
						Standby
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
