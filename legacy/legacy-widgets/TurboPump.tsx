import { useControl, useChannelControl } from '@/lib/controlHub';
import {
    Modal,
    ModalBody,
    ModalContent,
    ModalHeader,
    ModalFooter,
    Button,
    Input,
    Switch,
    useDraggable,
} from '@heroui/react';
import { useRef, useState } from 'react';


interface TurboPumpState {
    channels: Array<{
        name: string;
        status: string;
        isRunning: boolean;
        actualSpeed: number;
        targetSpeed: number;
        current: number;
        power: number;
        voltage: number;
        operatingHours: number;
        errorCode: string;
        standby: boolean;
    }>;
}


export function TurboPump({
    label,
    channel = 0,
    innerClassName = '',
}: {
    label?: React.ReactNode;
    channel?: number;
    innerClassName?: string;
}) {
    const { state, action } = useControl<TurboPumpState>('turbopumps');
    const [pumpState, channelAction] = useChannelControl(state, action, channel);
    const [isShownAsModal, setIsShownAsModal] = useState(false);
    const [targetSpeed, setTargetSpeed] = useState(1000);

    const targetRef = useRef<HTMLElement>(null);
    const { moveProps } = useDraggable({
        targetRef,
        isDisabled: !isShownAsModal,
    });

    const getStatusColor = (status: string) => {
        if (status.includes('error')) return 'text-red-500';
        if (status === 'running') return 'text-green-500';
        if (status === 'stopped') return 'text-orange-500';
        if (status === 'standby') return 'text-yellow-500';
        return 'text-slate-400';
    };

    const compactView = pumpState ? (
        <div className="flex items-center gap-3 text-xs">
            <span className={`font-bold ${pumpState.isRunning ? 'text-green-400' : 'text-orange-400'}`}>
                {pumpState.isRunning ? '▶ RUN' : '■ STOP'}
            </span>
            <div>
                <span className="text-slate-500">Speed:</span>
                <span className="ml-1 font-bold text-blue-400">
                    {pumpState.actualSpeed.toFixed(0)} Hz
                </span>
            </div>
            <div>
                <span className="text-slate-500">I:</span>
                <span className="ml-1 font-bold text-green-400">
                    {pumpState.current.toFixed(2)} A
                </span>
            </div>
        </div>
    ) : (
        <div className="text-slate-500 text-xs">Connecting...</div>
    );

    return (
        <>
            <Modal
                ref={targetRef}
                isOpen={isShownAsModal}
                onOpenChange={setIsShownAsModal}
                backdrop="transparent"
                size="3xl"
            >
                <ModalContent>
                    <ModalHeader {...moveProps}>
                        {label || pumpState?.name}
                    </ModalHeader>
                    <ModalBody className="py-6">
                        {pumpState && (
                            <div className="space-y-6">
                                {/* Status */}
                                <div className="bg-slate-900 rounded-lg p-4">
                                    <div className="text-sm text-slate-500 mb-2">Status</div>
                                    <div className={`text-2xl font-bold ${getStatusColor(pumpState.status)}`}>
                                        {pumpState.status.toUpperCase()}
                                    </div>
                                </div>

                                {/* Hauptwerte */}
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="bg-slate-900 rounded-lg p-4">
                                        <div className="text-sm text-slate-500">Drehzahl</div>
                                        <div className="text-3xl font-bold text-blue-400">
                                            {pumpState.actualSpeed.toFixed(0)}
                                            <span className="text-lg ml-2">Hz</span>
                                        </div>
                                        <div className="text-xs text-slate-500 mt-1">
                                            Soll: {pumpState.targetSpeed} Hz
                                        </div>
                                    </div>

                                    <div className="bg-slate-900 rounded-lg p-4">
                                        <div className="text-sm text-slate-500">Motorstrom</div>
                                        <div className="text-3xl font-bold text-green-400">
                                            {pumpState.current.toFixed(2)}
                                            <span className="text-lg ml-2">A</span>
                                        </div>
                                    </div>

                                    <div className="bg-slate-900 rounded-lg p-4">
                                        <div className="text-sm text-slate-500">Leistung</div>
                                        <div className="text-3xl font-bold">
                                            {pumpState.power}
                                            <span className="text-lg ml-2">W</span>
                                        </div>
                                    </div>

                                    <div className="bg-slate-900 rounded-lg p-4">
                                        <div className="text-sm text-slate-500">Spannung</div>
                                        <div className="text-3xl font-bold">
                                            {pumpState.voltage.toFixed(1)}
                                            <span className="text-lg ml-2">V</span>
                                        </div>
                                    </div>
                                </div>

                                {/* Weitere Infos */}
                                <div className="bg-slate-900 rounded-lg p-4">
                                    <div className="grid grid-cols-2 gap-3 text-sm">
                                        <div>
                                            <span className="text-slate-500">Betriebsstunden:</span>
                                            <span className="ml-2 font-bold">
                                                {pumpState.operatingHours} h
                                            </span>
                                        </div>
                                        <div>
                                            <span className="text-slate-500">Fehlercode:</span>
                                            <span className={`ml-2 font-bold ${
                                                pumpState.errorCode !== '000000' ? 'text-red-500' : ''
                                            }`}>
                                                {pumpState.errorCode}
                                            </span>
                                        </div>
                                    </div>
                                </div>

                                {/* Steuerung */}
                                <div className="space-y-4">
                                    <div className="flex gap-3">
                                        <Button
                                            color="success"
                                            size="lg"
                                            className="flex-1"
                                            isDisabled={pumpState.isRunning}
                                            onPress={() => channelAction('start_pump')}
                                        >
                                            ▶ START
                                        </Button>
                                        <Button
                                            color="warning"
                                            size="lg"
                                            className="flex-1"
                                            isDisabled={!pumpState.isRunning}
                                            onPress={() => channelAction('stop_pump')}
                                        >
                                            ■ STOP
                                        </Button>
                                        <Button
                                            color="danger"
                                            size="lg"
                                            className="flex-1"
                                            onPress={() => {
                                                if (confirm('Notaus aktivieren?')) {
                                                    channelAction('emergency_stop');
                                                }
                                            }}
                                        >
                                            ⚠ NOTAUS
                                        </Button>
                                    </div>

                                    {/* Speed Control */}
                                    <div className="flex gap-3 items-end">
                                        <Input
                                            type="number"
                                            label="Soll-Drehzahl (Hz)"
                                            value={targetSpeed.toString()}
                                            onChange={(e) => setTargetSpeed(+e.target.value)}
                                            min={0}
                                            max={1500}
                                            className="flex-1"
                                        />
                                        <Button
                                            color="primary"
                                            onPress={() => channelAction('set_speed', targetSpeed)}
                                        >
                                            Setzen
                                        </Button>
                                    </div>

                                    {/* Standby */}
                                    <div className="flex items-center justify-between bg-slate-900 rounded-lg p-4">
                                        <span className="text-slate-300">Standby-Modus</span>
                                        <Switch
                                            isSelected={pumpState.standby}
                                            onValueChange={(value) =>
                                                channelAction('set_standby', value)
                                            }
                                        />
                                    </div>
                                </div>
                            </div>
                        )}
                    </ModalBody>
                    <ModalFooter>
                        <Button
                            color="default"
                            variant="light"
                            onPress={() => channelAction('get_details').then(console.log)}
                        >
                            Details anzeigen
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>

            {/* Compact View */}
            <div
                className="bg-slate-800 h-16 rounded-xl px-4 py-2 flex flex-col justify-center cursor-pointer hover:bg-slate-700 transition-colors"
                onDoubleClick={() => setIsShownAsModal(true)}
            >
                {label && <div className="text-slate-500 text-xs mb-1.5">{label}</div>}
                <div className={innerClassName}>
                    {compactView}
                </div>
            </div>
        </>
    );
}
