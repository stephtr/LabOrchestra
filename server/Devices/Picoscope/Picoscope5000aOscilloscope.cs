using System.Runtime.InteropServices;
using System.Text;
using PS5000AImports;

public class Picoscope5000aOscilloscope : OscilloscopeWithStreaming
{
	private short Handle;
	private Lock DeviceLock = new Lock();
	public Picoscope5000aOscilloscope()
	{
		var serials = new StringBuilder(2048);
		short serialsLength = (short)serials.Capacity;

		Imports.EnumerateUnits(out var count, serials, ref serialsLength);

		var status = Imports.OpenUnit(out Handle, null!, Imports.DeviceResolution.PS5000A_DR_14BIT);
		if (status == PicoStatus.StatusCodes.PICO_POWER_SUPPLY_NOT_CONNECTED || status == PicoStatus.StatusCodes.PICO_USB3_0_DEVICE_NON_USB3_0_PORT)
		{
			status = Imports.ChangePowerSource(Handle, status);
		}
		if (status != PicoStatus.StatusCodes.PICO_OK)
		{
			throw new Exception("Failed to open Picoscope device");
		}
	}

	private void SetChannel(int channel, int rangeInMillivolts, bool active, string coupling)
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
		lock (DeviceLock)
		{
			var status = Imports.SetChannel(Handle, (Imports.Channel)channel, active ? (short)1 : (short)0, coupling == "AC" ? Imports.Coupling.PS5000A_AC : Imports.Coupling.PS5000A_DC, range, 0);
			if (status != PicoStatus.StatusCodes.PICO_OK)
			{
				throw new Exception("Failed to set channel range");
			}
		}
	}

	override public void SetRange(int channel, int rangeInMillivolts)
	{
		var wasRunning = State.Running;
		if (wasRunning) Stop();
		SetChannel(channel, rangeInMillivolts, State.Channels[channel].ChannelActive, State.Channels[channel].Coupling);
		base.SetRange(channel, rangeInMillivolts);
		if (wasRunning) Start();
	}

	override public void SetChannelActive(int channel, bool active)
	{
		var wasRunning = State.Running;
		if (wasRunning) Stop();
		SetChannel(channel, State.Channels[channel].RangeInMillivolts, active, State.Channels[channel].Coupling);
		base.SetChannelActive(channel, active);
		if (wasRunning) Start();
	}

	override public void SetCoupling(int channel, string coupling)
	{
		var wasRunning = State.Running;
		if (wasRunning) Stop();
		if (coupling != "AC" && coupling != "DC")
			throw new ArgumentException($"Invalid mode {coupling}");
		SetChannel(channel, State.Channels[channel].RangeInMillivolts, State.Channels[channel].ChannelActive, coupling);
		base.SetCoupling(channel, coupling);
		if (wasRunning) Start();
	}

	override protected void OnStart(CancellationToken cancellationToken)
	{
		var buffer_length = 65536u * 10;
		var buffers = new[] { new short[buffer_length], new short[buffer_length], new short[buffer_length], new short[buffer_length] };
		var GCHandles = new GCHandle[4];
		for (int ch = 0; ch < 4; ch++)
		{
			GCHandles[ch] = GCHandle.Alloc(buffers[ch], GCHandleType.Pinned);
			Imports.SetDataBuffer(Handle, (Imports.Channel)ch, buffers[ch], (int)buffer_length, 0, Imports.RatioMode.None);
		}
		void cleanupHandles()
		{
			for (int ch = 0; ch < 4; ch++)
			{
				GCHandles[ch].Free();
			}
		}

		var sampleInterval = (uint)(1e9 / 2 / State.FFTFrequency);
		Imports.MaximumValue(Handle, out var maxValue);
		Imports.SetSimpleTrigger(Handle, 0, 0, 0, Imports.ThresholdDirection.None, 0, 0);
		var status = Imports.RunStreaming(Handle, ref sampleInterval, Imports.ReportedTimeUnits.NanoSeconds, 0, buffer_length, 0, 1, Imports.RatioMode.None, buffer_length);
		if (status != PicoStatus.StatusCodes.PICO_OK)
		{
			cleanupHandles();
			throw new Exception($"Failed to start acquisition (0x{status:X})");
		}
		Dt = sampleInterval * 1e-9;

		Task.Run(() =>
		{
			ulong samplesReceived = 0;
			ulong triggerCount = 0;
			var values = new float[buffer_length];

			void StreamingCallback(short handle, int noOfSamples, uint startIndex, short overflow, uint triggerAt, short triggered, short autoStop, IntPtr pVoid)
			{
				try
				{
					samplesReceived += (ulong)noOfSamples;
					triggerCount += 1;
					if (autoStop != 0)
					{
						State.Running = false;
						SendStateUpdate(new { State.Running });
					}
					if (noOfSamples == 0) return;
					var isRecording = IsRecording;
					for (int ch = 0; ch < 4; ch++)
					{
						if (State.Channels[ch].ChannelActive)
						{
							var buffer = buffers[ch];
							var conversionFactor = State.Channels[ch].RangeInMillivolts / (maxValue * 1000f);
							unsafe
							{
								fixed (short* bufferPtr = buffer)
								fixed (float* valuesPtr = values)
								{
									short* bufferStartPtr = bufferPtr + startIndex;
									float* valuesStartPtr = valuesPtr;
									for (long i = 0; i < noOfSamples; i++)
									{
										*valuesStartPtr++ = *bufferStartPtr++ * conversionFactor;
									}
								}
							}
							Buffer[ch].Push(values, noOfSamples);
							if (isRecording) RecordingBuffer[ch].Push(values, noOfSamples);
						}
					}
				}
				catch (Exception ex)
				{
					Console.WriteLine($"Error in oscilloscope streaming callback: {ex.Message}");
				}
			}

			var lastAcquisitionRestart = DateTime.MinValue;
			try
			{
				while (!cancellationToken.IsCancellationRequested)
				{
					lock (DeviceLock)
					{
						for (var i = 0; i < 1000; i++)
						{
							var result = Imports.GetStreamingLatestValues(Handle, StreamingCallback, IntPtr.Zero);
							switch (result)
							{
								case PicoStatus.StatusCodes.PICO_OK:
								case PicoStatus.StatusCodes.PICO_BUSY:
									break;
								case PicoStatus.StatusCodes.PICO_NOT_RESPONDING:
									{
										Console.WriteLine("WARNING: Picoscope not responding. Restarting acquisition.");
										Imports.Stop(Handle);
										if (DateTime.UtcNow - lastAcquisitionRestart < TimeSpan.FromSeconds(10))
										{
											Console.WriteLine("Picoscope stopped responding within 10 seconds of restarting acquisition");
											throw new Exception("Picoscope stopped responding within 10 seconds of restarting acquisition");
										}
										lastAcquisitionRestart = DateTime.UtcNow;
										result = Imports.RunStreaming(Handle, ref sampleInterval, Imports.ReportedTimeUnits.NanoSeconds, 0, buffer_length, 0, 1, Imports.RatioMode.None, buffer_length);
										if (result != PicoStatus.StatusCodes.PICO_OK)
										{
											base.Stop();
											Console.WriteLine($"Failed to automatically restart acquisition (0x{result:X})");
											throw new Exception($"Failed to automatically restart acquisition (0x{result:X})");
										}
										break;
									}
								default: Console.WriteLine($"Picoscope alert: 0x{result:X}"); break;
							}
							Thread.Sleep(0);
						}
					}
				}
			}
			finally
			{
				cleanupHandles();
			}
		});
	}

	override public void Stop()
	{
		base.Stop();
		lock (DeviceLock)
		{
			Imports.Stop(Handle);
		}
	}

	override public void SetTestSignalFrequency(float frequency)
	{
		lock (DeviceLock)
		{
			var status = Imports.SetSigGenBuiltInV2(Handle, 0, 800_000, Imports.WaveType.PS5000A_GAUSSIAN, (int)frequency, (int)frequency, 0, 0, Imports.SweepType.PS5000A_UP, 0, 0xFFFFFFFF, 0, 0, Imports.SigGenTrigSource.PS5000A_SIGGEN_NONE, 0);
			if (status != PicoStatus.StatusCodes.PICO_OK)
			{
				throw new Exception($"Failed to set channel range ({status})");
			}
		}
		base.SetTestSignalFrequency(frequency);
	}

	public override Task OnRecord(Func<string, Stream> getStream, string deviceId, CancellationToken cancellationToken)
	{
		lock (DeviceLock)
		{
			return base.OnRecord(getStream, deviceId, cancellationToken);
		}
	}

	override public void Dispose()
	{
		base.Dispose();

		lock (DeviceLock)
		{
			Imports.Stop(Handle);
			Imports.CloseUnit(Handle);
		}
		Handle = -1;
	}
}
