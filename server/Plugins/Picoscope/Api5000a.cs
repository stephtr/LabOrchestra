using System.Text;
using PS5000AImports;

namespace LabOrchestra.Plugins.Picoscope;

internal sealed class Api5000a : IPicoApi
{
	public string LibraryName => "ps5000a";
	public int ChannelCount => 4;

	public uint Open(out short handle)
	{
		var serials = new StringBuilder(2048);
		short length = (short)serials.Capacity;
		Imports.EnumerateUnits(out _, serials, ref length);
		return Imports.OpenUnit(out handle, null!, Imports.DeviceResolution.PS5000A_DR_14BIT);
	}

	public uint ChangePowerSource(short handle, uint status) => Imports.ChangePowerSource(handle, status);

	public uint SetChannel(short handle, int channel, bool enabled, bool dc, int rangeInMillivolts) =>
		Imports.SetChannel(handle, (Imports.Channel)channel, enabled ? (short)1 : (short)0, dc ? Imports.Coupling.PS5000A_DC : Imports.Coupling.PS5000A_AC,
			(Imports.Range)PicoRanges.Index(rangeInMillivolts, 10), 0);

	public uint MaximumValue(short handle, out short value) => Imports.MaximumValue(handle, out value);

	public uint SetDataBuffer(short handle, int channel, short[] buffer) =>
		Imports.SetDataBuffer(handle, (Imports.Channel)channel, buffer, buffer.Length, 0, Imports.RatioMode.None);

	public uint DisableTrigger(short handle) => Imports.SetSimpleTrigger(handle, 0, 0, 0, Imports.ThresholdDirection.None, 0, 0);

	public uint RunStreaming(short handle, ref uint sampleIntervalNanoseconds, uint bufferLength) =>
		Imports.RunStreaming(handle, ref sampleIntervalNanoseconds, Imports.ReportedTimeUnits.NanoSeconds, 0, bufferLength, 0, 1, Imports.RatioMode.None, bufferLength);

	public uint GetLatestValues(short handle, StreamingReady callback) =>
		Imports.GetStreamingLatestValues(handle, (_, count, start, _, _, _, autoStop, _) => callback(count, start, autoStop != 0), IntPtr.Zero);

	public uint Stop(short handle) => Imports.Stop(handle);
	public uint Close(short handle) => Imports.CloseUnit(handle);

	public bool HasSignalGenerator => true;

	// The waveform is the one the legacy dashboard used for its test signal (Gaussian pulses), not a sine.
	public uint SetSignal(short handle, double frequency, uint peakToPeakMicrovolts) =>
		Imports.SetSigGenBuiltInV2(handle, 0, peakToPeakMicrovolts, Imports.WaveType.PS5000A_GAUSSIAN, (int)frequency, (int)frequency, 0, 0, Imports.SweepType.PS5000A_UP, 0, 0xFFFFFFFF, 0, 0, Imports.SigGenTrigSource.PS5000A_SIGGEN_NONE, 0);
}
