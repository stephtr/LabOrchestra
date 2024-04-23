using System.Runtime.InteropServices;
using PS5000AImports;

public class Picoscope5000aOscilloscope : OscilloscopeWithStreaming
{
	private short _handle;
	public Picoscope5000aOscilloscope()
	{
		var status = Imports.OpenUnit(out _handle, null!, Imports.DeviceResolution.PS5000A_DR_12BIT);
		if (status == PicoStatus.StatusCodes.PICO_POWER_SUPPLY_NOT_CONNECTED || status == PicoStatus.StatusCodes.PICO_USB3_0_DEVICE_NON_USB3_0_PORT)
		{
			status = Imports.ChangePowerSource(_handle, status);
		}
		if (status != PicoStatus.StatusCodes.PICO_OK)
		{
			throw new Exception("Failed to open Picoscope device");
		}
		Imports.SetSigGenBuiltInV2(_handle, 0, 800_000, Imports.WaveType.PS5000A_GAUSSIAN, 2_000_000, 2_000_000, 0, 0, Imports.SweepType.PS5000A_UP, 0, 0xFFFFFFFF, 0, 0, Imports.SigGenTrigSource.PS5000A_SIGGEN_NONE, 0);
	}

	override public void UpdateRange(int channel, int rangeInMillivolts)
	{
		var range = rangeInMillivolts switch
		{
			10 => Imports.Range.Range_10mV,
			20 => Imports.Range.Range_20mV,
			50 => Imports.Range.Range_50mV,
			100 => Imports.Range.Range_100mV,
			200 => Imports.Range.Range_200mV,
			500 => Imports.Range.Range_500mV,
			1000 => Imports.Range.Range_1V,
			2000 => Imports.Range.Range_2V,
			5000 => Imports.Range.Range_5V,
			10000 => Imports.Range.Range_10V,
			20000 => Imports.Range.Range_20V,
			_ => throw new NotSupportedException(),
		};
		lock (this)
		{
			var status = Imports.SetChannel(_handle, (Imports.Channel)channel, _state.Channels[channel].ChannelActive ? (short)1 : (short)0, Imports.Coupling.PS5000A_AC, range, 0);
			if (status != PicoStatus.StatusCodes.PICO_OK)
			{
				throw new Exception("Failed to set channel range");
			}
		}
		base.UpdateRange(channel, rangeInMillivolts);
		if (_state.Running) Start();
	}

	override public void ChannelActive(int channel, bool active)
	{
		var range = _state.Channels[channel].RangeInMillivolts switch
		{
			10 => Imports.Range.Range_10mV,
			20 => Imports.Range.Range_20mV,
			50 => Imports.Range.Range_50mV,
			100 => Imports.Range.Range_100mV,
			200 => Imports.Range.Range_200mV,
			500 => Imports.Range.Range_500mV,
			1000 => Imports.Range.Range_1V,
			2000 => Imports.Range.Range_2V,
			5000 => Imports.Range.Range_5V,
			10000 => Imports.Range.Range_10V,
			20000 => Imports.Range.Range_20V,
			_ => throw new NotSupportedException(),
		};
		lock (this)
		{
			var status = Imports.SetChannel(_handle, (Imports.Channel)channel, active ? (short)1 : (short)0, Imports.Coupling.PS5000A_AC, range, 0);
			if (status != PicoStatus.StatusCodes.PICO_OK)
			{
				throw new Exception("Failed to set channel range");
			}
		}
		base.ChannelActive(channel, active);
		if (_state.Running) Start();
	}

	override public void Start()
	{
		base.Start();

		var localRunId = _runId;
		var buffer_length = 65536u * 50;
		var buffers = new[] { new short[buffer_length], new short[buffer_length], new short[buffer_length], new short[buffer_length] };
		var GCHandles = new GCHandle[4];
		for (int ch = 0; ch < 4; ch++)
		{
			_buffer[ch].Clear();
			GCHandles[ch] = GCHandle.Alloc(buffers[ch], GCHandleType.Pinned);
			Imports.SetDataBuffer(_handle, (Imports.Channel)ch, buffers[ch], (int)buffer_length, 0, Imports.RatioMode.None);
		}
		var sampleInterval = (uint)(1e9 / 2 / _state.FFTFrequency);
		Imports.MaximumValue(_handle, out var maxValue);
		Imports.SetSimpleTrigger(_handle, 0, 0, 0, Imports.ThresholdDirection.None, 0, 0);
		var status = Imports.RunStreaming(_handle, ref sampleInterval, Imports.ReportedTimeUnits.NanoSeconds, 0, buffer_length, 0, 1, Imports.RatioMode.None, buffer_length);
		if (status != PicoStatus.StatusCodes.PICO_OK)
		{
			throw new Exception($"Failed to start acquisition ({status:X})");
		}
		_dt = sampleInterval * 1e-9;
		_df = 1 / (_state.FFTLength * _dt);

		Task.Run(() =>
		{
			ulong samplesReceived = 0;
			ulong triggerCount = 0;

			void StreamingCallback(short handle, int noOfSamples, uint startIndex, short overflow, uint triggerAt, short triggered, short autoStop, IntPtr pVoid)
			{
				samplesReceived += (ulong)noOfSamples;
				triggerCount += 1;
				if (autoStop != 0)
				{
					_state.Running = false;
					SendStateUpdate(new { Running = false });
				}
				if (noOfSamples > 0)
				{
					for (int ch = 0; ch < 4; ch++)
					{
						if (_state.Channels[ch].ChannelActive)
						{
							var conversionFactor = _state.Channels[ch].RangeInMillivolts / (maxValue * 1000f);
							var values = new float[noOfSamples];
							for (long i = 0; i < noOfSamples; i++)
							{
								values[i] = buffers[ch][startIndex + i] * conversionFactor;
							}
							_buffer[ch].Push(values);
						}
					}
				}
			}

			while (_state.Running && _runId == localRunId)
			{
				lock (this)
				{
					for (var i = 0; i < 1000; i++)
					{
						Imports.GetStreamingLatestValues(_handle, StreamingCallback, IntPtr.Zero);
						Thread.Sleep(0);
					}
				}
			}
			for (int ch = 0; ch < 4; ch++)
			{
				GCHandles[ch].Free();
			}
		});
	}

	override public void Stop()
	{
		base.Stop();
		lock (this)
		{
			Imports.Stop(_handle);
		}
	}

	override public void SetTestSignalFrequency(float frequency)
	{
		lock (this)
		{
			var status = Imports.SetSigGenBuiltInV2(_handle, 0, 800_000, Imports.WaveType.PS5000A_GAUSSIAN, (int)frequency, (int)frequency, 0, 0, Imports.SweepType.PS5000A_UP, 0, 0xFFFFFFFF, 0, 0, Imports.SigGenTrigSource.PS5000A_SIGGEN_NONE, 0);
			if (status != PicoStatus.StatusCodes.PICO_OK)
			{
				throw new Exception($"Failed to set channel range ({status})");
			}
		}
		base.SetTestSignalFrequency(frequency);
	}

	override public void Dispose()
	{
		base.Dispose();

		Imports.Stop(_handle);
		Imports.CloseUnit(_handle);
		_handle = -1;
	}
}
