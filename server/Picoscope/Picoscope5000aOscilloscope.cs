using System.Diagnostics;
using System.Runtime.InteropServices;
using MathNet.Numerics.IntegralTransforms;
using PS5000AImports;

public class Picoscope5000aOscilloscope : DeviceHandlerBase<OscilloscopeState>, IOscilloscope
{
	private short _handle;
	private CircularBuffer<float>[] _buffer = [new(100_000_000), new(100_000_000), new(100_000_000), new(100_000_000)];
	private double[][] _fftStorage = [[], [], [], []];
	private int[] _acquiredFFTs = { 0, 0, 0, 0 };
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
	}

	public void UpdateRange(int channel, int rangeInMillivolts)
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
		var status = Imports.SetChannel(_handle, (Imports.Channel)channel, _state.Channels[channel].ChannelActive ? (short)1 : (short)0, Imports.Coupling.PS5000A_AC, range, 0);
		if (status != PicoStatus.StatusCodes.PICO_OK)
		{
			throw new Exception("Failed to set channel range");
		}
		_state.Channels[channel].RangeInMillivolts = rangeInMillivolts;
	}

	public void ChannelActive(int channel, bool active)
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
		_state.Channels[channel].ChannelActive = active;
		var status = Imports.SetChannel(_handle, (Imports.Channel)channel, _state.Channels[channel].ChannelActive ? (short)1 : (short)0, Imports.Coupling.PS5000A_AC, range, 0);
		if (status != PicoStatus.StatusCodes.PICO_OK)
		{
			throw new Exception("Failed to set channel range");
		}
		// _fftStorage[channel] = new double[_state.FFTLength / 2 + 1];
		// _acquiredFFTs[channel] = 0;
	}

	private void ResetFFTStorage()
	{
		for (int i = 0; i < _fftStorage.Length; i++)
			_fftStorage[i] = new double[_state.FFTLength / 2 + 1];
		_acquiredFFTs = [0, 0, 0, 0];
	}

	public void Start()
	{
		ResetFFTStorage();
		Imports.SetSimpleTrigger(_handle, 0, 0, 0, Imports.ThresholdDirection.None, 0, 0);
		var buffer_length = 65536u;
		var buffers = new[] { new short[buffer_length], new short[buffer_length], new short[buffer_length], new short[buffer_length] };
		var GCHandles = new GCHandle[4];
		for (int ch = 0; ch < 4; ch++)
		{
			_buffer[ch].Clear();
			GCHandles[ch] = GCHandle.Alloc(buffers[ch], GCHandleType.Pinned);
			Imports.SetDataBuffer(_handle, (Imports.Channel)ch, buffers[ch], (int)buffer_length, 0, Imports.RatioMode.None);
		}
		var sampleInterval = 100u;
		Imports.MaximumValue(_handle, out var maxValue);
		Imports.RunStreaming(_handle, ref sampleInterval, Imports.ReportedTimeUnits.NanoSeconds, 0, buffer_length, 0, 1, Imports.RatioMode.None, buffer_length);
		var dt = sampleInterval * 1e-9;
		var df = 1 / (_state.FFTLength * dt);

		void StreamingCallback(short handle, int noOfSamples, uint startIndex, short overflow, uint triggerAt, short triggered, short autoStop, IntPtr pVoid)
		{
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

		Task.Run(() =>
		{
			while (_state.Running)
			{
				Imports.GetStreamingLatestValues(_handle, StreamingCallback, IntPtr.Zero);
				Thread.Sleep(0);
			}
			for (int ch = 0; ch < 4; ch++)
			{
				GCHandles[ch].Free();
			}
		});

		Task.Run(() =>
		{
			while (_state.Running)
			{
				Thread.Sleep(1);
				for (var ch = 0; ch < 4; ch++)
				{
					var fft = new float[_state.FFTLength + 2];
					if (_state.Channels[ch].ChannelActive && _buffer[ch].Count > _state.FFTLength)
					{
						_buffer[ch].Pop(_state.FFTLength, fft);
						Fourier.ForwardReal(fft, _state.FFTLength);
						var newWeight = 1.0 / (_acquiredFFTs[ch] + 1);
						var oldWeight = 1.0 - newWeight;
						for (int i = 0; i < _state.FFTLength / 2 + 1; i++)
						{
							var val = Convert.ToDouble(fft[i * 2] * fft[i * 2] + fft[i * 2 + 1] * fft[i * 2 + 1]);
							val *= 1 / df;
							if (_state.FFTAveragingMode == "prefer-display")
							{
								val = Math.Log10(val) * 10;
							}
							_fftStorage[ch][i] = _fftStorage[ch][i] * oldWeight + val * newWeight;
						}
						_acquiredFFTs[ch]++;
					}
				}
			}
		});

		Task.Run(() =>
		{
			DateTime lastTransmission = DateTime.MinValue;
			while (_state.Running)
			{
				if (DateTime.UtcNow - lastTransmission > TimeSpan.FromSeconds(1.0 / 30))
				{
					Thread.Sleep(5);
					continue;
				}
				var channelData = new float[_state.Channels.Length][];
				switch (_state.TimeMode)
				{
					case "time":
						for (var ch = 0; ch < channelData.Length; ch++)
						{
							if (_state.Channels[ch].ChannelActive)
							{
								channelData[ch] = _buffer[ch].PeekHead(_state.FFTLength, readPastTail: true);
							}
						}
						SendStreamData(new { XMin = 0, XMax = dt * (_state.FFTLength - 1), Data = channelData, Mode = "time", Length = _state.FFTLength });
						break;
					case "fft":
						for (var ch = 0; ch < channelData.Length; ch++)
						{
							if (_state.Channels[ch].ChannelActive)
							{
								var data = new float[_state.FFTLength / 2 + 1];
								for (int i = 0; i < _state.FFTLength / 2 + 1; i++)
									data[i] = Convert.ToSingle(
										_state.FFTAveragingMode == "prefer-display" ?
											_fftStorage[ch][i] :
											Math.Log10(_fftStorage[ch][i]) * 10
									);
								channelData[ch] = data;
							}
						}
						SendStreamData(new { XMin = 0, XMax = 1 / (2 * dt), Data = channelData, Mode = "fft", Length = _state.FFTLength / 2 + 1 });
						break;
				}
			}
		});
	}

	public void Stop()
	{
		_state.Running = false;
		Imports.Stop(_handle);
	}

	public void SetTimeMode(string mode)
	{
		if (mode != "time" && mode != "fft")
			throw new ArgumentException($"Invalid mode {mode}");
		_state.TimeMode = mode;
	}

	public void SetFFTBinCount(int length)
	{
		// throw new NotImplementedException();
	}

	public void SetAveragingMode(string mode)
	{
		if (mode != "prefer-data" && mode != "prefer-display")
			throw new ArgumentException($"Invalid mode {mode}");
		_state.FFTAveragingMode = mode;
		ResetFFTStorage();
	}
}
