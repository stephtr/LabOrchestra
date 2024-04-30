using System.IO.Compression;
using MathNet.Numerics.IntegralTransforms;
using NumSharp;

public class OscilloscopeChannel
{
	public bool ChannelActive { get; set; } = false;
	public int RangeInMillivolts { get; set; } = 1000;
	public string Coupling { get; set; } = "AC";
}

public class OscilloscopeState
{
	public bool Running { get; set; } = true;
	public string TimeMode { get; set; } = "time"; // Default mode is "time"
	public float FFTFrequency { get; set; } = 10e6f;
	public int FFTLength { get; set; } = 32768;
	public string FFTAveragingMode { get; set; } = "prefer-data";
	public int FFTAveragingDurationInMilliseconds { get; set; } = 0;
	public string FFTWindowFunction { get; set; } = "blackman";
	public float TestSignalFrequency { get; set; } = 1e6f;
	public int DatapointsToSnapshot { get; set; } = 100_000_000;

	public OscilloscopeChannel[] Channels { get; set; } =
	{
		new OscilloscopeChannel(),
		new OscilloscopeChannel(),
		new OscilloscopeChannel(),
		new OscilloscopeChannel(),
	};
}

interface IOscilloscope
{
	void Start();
	void Stop();
	void SetTimeMode(string mode);
	void SetFFTBinCount(int length);
	void SetAveragingMode(string mode);
	void SetFFTAveragingDuration(int durationInMilliseconds);
	void ChannelActive(int channel, bool active);
	void UpdateRange(int channel, int rangeInMillivolts);
	void ResetFFTStorage();
	void SetFFTWindowFunction(string windowFuction);
	void SetTestSignalFrequency(float frequency);
	void SetCoupling(int channel, string coupling);
	void SetDatapointsToSnapshot(int datapoints);
}

public class OscilloscopeHandler : DeviceHandlerBase<OscilloscopeState>, IOscilloscope
{
	private double[][] _fftStorage = [[], [], [], []];
	private float[] _fftWindowFunction = Array.Empty<float>();
	private float[][] _signal = [[], [], [], []];
	private int[] _acquiredFFTs = { 0, 0, 0, 0 };
	private double _updateInterval = 50e-3;
	public OscilloscopeHandler()
	{
	}

	public void ResetFFTStorage()
	{
		for (int i = 0; i < _fftStorage.Length; i++)
		{
			_fftStorage[i] = new double[_state.FFTLength / 2 + 1];
			_signal[i] = new float[_state.FFTLength];
		}
		_acquiredFFTs = [0, 0, 0, 0];
		ResetFFTWindow();
	}

	private void ResetFFTWindow()
	{
		_fftWindowFunction = new float[_state.FFTLength];
		var N = _state.FFTLength - 1;
		switch (_state.FFTWindowFunction)
		{
			case "rectangular":
				for (int i = 0; i < _state.FFTLength; i++)
					_fftWindowFunction[i] = 1;
				break;
			case "hann":
				for (int n = 0; n < _state.FFTLength; n++)
				{
					var sin = Math.Sin(Math.PI * n / N);
					_fftWindowFunction[n] = (float)(sin * sin);
				}
				break;
			case "blackman":
				for (int n = 0; n < _state.FFTLength; n++)
					_fftWindowFunction[n] = (float)(0.42 - 0.5 * Math.Cos(2 * Math.PI * n / N) + 0.08 * Math.Cos(4 * Math.PI * n / N));
				break;
			case "nuttall":
				for (int n = 0; n < _state.FFTLength; n++)
					_fftWindowFunction[n] = (float)(0.355768 - 0.487396 * Math.Cos(2 * Math.PI * n / N) + 0.144232 * Math.Cos(4 * Math.PI * n / N) - 0.012604 * Math.Cos(6 * Math.PI * n / N));
				break;
			default:
				throw new ArgumentException($"Invalid window function {_state.FFTWindowFunction}");
		}
	}

	public void Start()
	{
		ResetFFTStorage();
		_state.Running = true;
		Task.Run(() =>
		{
			while (_state.Running)
			{
				try
				{
					DoWork();
					Thread.Sleep((int)(_updateInterval * 1e3));
				}
				catch (Exception e)
				{
					Console.WriteLine(e);
				}
			}
		});
	}
	public void Stop()
	{
		_state.Running = false;
	}

	public void SetTimeMode(string mode)
	{
		if (mode != "time" && mode != "fft")
			throw new ArgumentException($"Invalid mode {mode}");
		_state.TimeMode = mode;
	}

	public void SetFFTBinCount(int length)
	{
		if (length < 1)
			throw new ArgumentException($"Invalid length {length}");
		_state.FFTLength = length;
		ResetFFTStorage();
	}

	public void SetAveragingMode(string mode)
	{
		if (mode != "prefer-data" && mode != "prefer-display")
			throw new ArgumentException($"Invalid mode {mode}");
		_state.FFTAveragingMode = mode;
		ResetFFTStorage();
	}

	public void ChannelActive(int channel, bool active)
	{
		_state.Channels[channel].ChannelActive = active;
		_fftStorage[channel] = new double[_state.FFTLength / 2 + 1];
		_acquiredFFTs[channel] = 0;
		_signal[channel] = new float[_state.FFTLength];
	}

	public void UpdateRange(int channel, int rangeInMillivolts)
	{
		_state.Channels[channel].RangeInMillivolts = rangeInMillivolts;
	}

	private void DoWork()
	{
		var dt = 1 / _state.FFTFrequency * (1 / 2 + 1);
		var df = _state.FFTFrequency / (_state.FFTLength / 2 + 1);

		if (!_state.Running) return;
		var rand = new Random();
		var channelData = new float[_state.Channels.Length][];
		for (var ch = 0; ch < channelData.Length; ch++)
		{
			if (_state.Channels[ch].ChannelActive)
			{
				for (int i = 0; i < _state.FFTLength; i++)
					_signal[ch][i] = rand.NextSingle() * 2 - 1;

				var fft = new float[_state.FFTLength + 2];
				Array.Copy(_signal[ch], fft, _state.FFTLength);
				if (_state.FFTWindowFunction != "rectangular")
				{
					for (int i = 0; i < _state.FFTLength; i++)
						fft[i] *= _fftWindowFunction[i];
				}
				Fourier.ForwardReal(fft, _state.FFTLength);

				var newWeight = 1.0 / (_acquiredFFTs[ch] + 1);
				if (_state.FFTAveragingDurationInMilliseconds == 0)
				{
					newWeight = 1.0;
				}
				else if (_state.FFTAveragingDurationInMilliseconds > 0)
				{
					newWeight = Math.Max(newWeight, 1 - Math.Exp(-_updateInterval / _state.FFTAveragingDurationInMilliseconds * 1000));
				}
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

				switch (_state.TimeMode)
				{
					case "time":
						channelData[ch] = _signal[ch];
						break;
					case "fft":
						var data = new float[_state.FFTLength / 2 + 1];
						for (int i = 0; i < _state.FFTLength / 2 + 1; i++)
							data[i] = Convert.ToSingle(
								_state.FFTAveragingMode == "prefer-display" ?
									_fftStorage[ch][i] :
									Math.Log10(_fftStorage[ch][i]) * 10
							);
						channelData[ch] = data;
						break;
				}
			}
		}
		double xMax = 0;
		int length = 0;
		switch (_state.TimeMode)
		{
			case "time":
				xMax = dt * (_state.FFTLength - 1);
				length = _state.FFTLength;
				break;
			case "fft":
				xMax = 1 / (2 * dt);
				length = _state.FFTLength / 2 + 1;
				break;
		}
		_deviceManager?.SendStreamData(_deviceManager.GetDeviceId(this), (data, customization) =>
		{
			var xMinWish = customization == null ? data.XMin : Convert.ToSingle(customization["xMin"]);
			var xMaxWish = customization == null ? data.XMax : Convert.ToSingle(customization["xMax"]);
			var xMin = 0f;
			var xMax = 0f;
			var length = 0;
			var reducedData = data.Data.Select(d =>
			{
				if (d == null) return null;
				var decimation = SignalUtils.DecimateSignal(d, data.XMin, data.XMax, xMinWish, xMaxWish, 1500);
				xMin = decimation.xMin;
				xMax = decimation.xMax;
				length = decimation.signal.Length;
				return decimation.signal;
			}).ToArray();
			return new { data.XMin, data.XMax, XMinDecimated = xMin, XMaxDecimated = xMax, data.Mode, Length = length, Data = reducedData };
		}, new { XMin = 0f, XMax = (float)xMax, Mode = _state.TimeMode, Length = length, Data = channelData });
	}

	public void SetFFTFrequency(float frequency)
	{
		_state.FFTFrequency = frequency;
	}

	public void SetFFTAveragingDuration(int durationInMilliseconds)
	{
		_state.FFTAveragingDurationInMilliseconds = durationInMilliseconds;
	}

	public void SetFFTWindowFunction(string windowFuction)
	{
		_state.FFTWindowFunction = windowFuction;
		ResetFFTWindow();
	}

	public void SetTestSignalFrequency(float frequency)
	{
		_state.TestSignalFrequency = frequency;
	}

	public override object? OnSave(ZipArchive archive, string deviceId)
	{
		var savedAnyTraces = false;
		for (var ch = 0; ch < _state.Channels.Length; ch++)
		{
			if (!_state.Channels[ch].ChannelActive) continue;

			using (var traceFile = archive.CreateEntry($"{deviceId}_C{ch + 1}").Open())
			{
				np.Save(_signal[ch], traceFile);
			}

			using (var fftFile = archive.CreateEntry($"{deviceId}_F{ch + 1}").Open())
			{
				np.Save(_fftStorage[ch], fftFile);
			}

			savedAnyTraces = true;
		}
		if (!savedAnyTraces) return null;

		var dt = 1 / _state.FFTFrequency * (1 / 2 + 1);
		var t = Enumerable.Range(0, _state.FFTLength).Select(i => (float)(i * dt)).ToArray();
		using (var tFile = archive.CreateEntry($"{deviceId}_t").Open())
		{
			np.Save(t, tFile);
		}

		var df = _state.FFTFrequency / (_state.FFTLength / 2 + 1);
		var f = Enumerable.Range(0, _state.FFTLength / 2 + 1).Select(i => (float)(i * df)).ToArray();
		using (var fFile = archive.CreateEntry($"{deviceId}_f").Open())
		{
			np.Save(f, fFile);
		}

		return null;
	}

	public void SetCoupling(int channel, string coupling)
	{
		if (coupling != "AC" && coupling != "DC")
			throw new ArgumentException($"Invalid mode {coupling}");
		_state.Channels[channel].Coupling = coupling;
	}

	public void SetDatapointsToSnapshot(int datapoints)
	{
		_state.DatapointsToSnapshot = datapoints;
	}
}
