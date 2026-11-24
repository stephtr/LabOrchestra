using PS4000AImports;

namespace LabOrchestra.Plugins.Picoscope;

internal sealed class Api4000a : IPicoApi
{
	public string LibraryName => "ps4000a";
	public int ChannelCount => 4;

	public uint Open(out short handle)
	{
		var status = Imports.OpenUnit(out handle, null!);
		if (status == PicoStatus.StatusCodes.PICO_OK) status = Imports.SetDeviceResolution(handle, Imports.DeviceResolution.PS4000A_DR_14BIT);
		return status;
	}

	public uint ChangePowerSource(short handle, uint status) => Imports.ps4000aChangePowerSource(handle, status);

	public uint SetChannel(short handle, int channel, bool enabled, bool dc, int rangeInMillivolts) =>
		Imports.SetChannel(handle, (Imports.Channel)channel, enabled ? (short)1 : (short)0, dc ? Imports.Coupling.DC : Imports.Coupling.AC,
			(Imports.Range)PicoRanges.Index(rangeInMillivolts, 13), 0);

	public uint MaximumValue(short handle, out short value) => Imports.MaximumValue(handle, out value);

	public uint SetDataBuffer(short handle, int channel, short[] buffer) =>
		Imports.SetDataBuffer(handle, (Imports.Channel)channel, buffer, buffer.Length, 0, Imports.DownSamplingMode.None);

	public uint DisableTrigger(short handle) => Imports.SetSimpleTrigger(handle, 0, 0, 0, Imports.ThresholdDirection.None, 0, 0);

	public uint RunStreaming(short handle, ref uint sampleIntervalNanoseconds, uint bufferLength) =>
		Imports.RunStreaming(handle, ref sampleIntervalNanoseconds, Imports.ReportedTimeUnits.NanoSeconds, 0, bufferLength, 0, 1, Imports.DownSamplingMode.None, bufferLength);

	public uint GetLatestValues(short handle, StreamingReady callback) =>
		Imports.GetStreamingLatestValues(handle, (_, count, start, _, _, _, autoStop, _) => callback(count, start, autoStop != 0), IntPtr.Zero);

	public uint Stop(short handle) => Imports.Stop(handle);
	public uint Close(short handle) => Imports.CloseUnit(handle);

	public uint? SetTestSignal(short handle, double frequency) => null; // the 4000a series has no built-in signal generator
}
