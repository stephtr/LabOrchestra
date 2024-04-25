using System.IO.Compression;
using MathNet.Numerics.IntegralTransforms;
using NumSharp;

public class OscilloscopeWithStreaming : DeviceHandlerBase<OscilloscopeState>, IOscilloscope
{
	protected CircularBuffer<float>[] _buffer = [new(100_000_000), new(100_000_000), new(100_000_000), new(100_000_000)];
	protected NDArray[] _fftStorage = [Array.Empty<double>(), Array.Empty<double>(), Array.Empty<double>(), Array.Empty<double>()];
	protected NDArray _fftWindowFunction = Array.Empty<float>();
	protected int[] _acquiredFFTs = { 0, 0, 0, 0 };
	protected double _dt = 0;
	protected double _df = 0;


	virtual public void UpdateRange(int channel, int rangeInMillivolts)
	{
		_state.Channels[channel].RangeInMillivolts = rangeInMillivolts;
	}

	virtual public void ChannelActive(int channel, bool active)
	{
		_state.Channels[channel].ChannelActive = active;
	}

	public void SetFFTFrequency(float freq)
	{
		var wasRunning = _state.Running;
		if (wasRunning)
		{
			Stop();
		}
		_state.FFTFrequency = freq;
		if (wasRunning)
		{
			Start();
		}
	}

	public void ResetFFTStorage()
	{
		for (int i = 0; i < _fftStorage.Length; i++)
			_fftStorage[i] = np.zeros<double>(_state.FFTLength / 2 + 1);
		_acquiredFFTs = [0, 0, 0, 0];
		ResetFFTWindow();
	}

	protected void ResetFFTWindow()
	{
		var array = new float[_state.FFTLength + 2];
		var N = _state.FFTLength - 1;
		switch (_state.FFTWindowFunction)
		{
			case "rectangular":
				for (int n = 0; n < _state.FFTLength; n++)
					array[n] = 1;
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
					array[n] = (float)(0.42 - 0.5 * Math.Cos(2 * Math.PI * n / N) + 0.08 * Math.Cos(4 * Math.PI * n / N));
				break;
			case "nuttall":
				for (int n = 0; n < _state.FFTLength; n++)
					array[n] = (float)(0.355768 - 0.487396 * Math.Cos(2 * Math.PI * n / N) + 0.144232 * Math.Cos(4 * Math.PI * n / N) - 0.012604 * Math.Cos(6 * Math.PI * n / N));
				break;
			default:
				throw new ArgumentException($"Invalid window function {_state.FFTWindowFunction}");
		}
		_fftWindowFunction = np.array(array);
	}

	public void SetTimeMode(string mode)
	{
		if (mode != "time" && mode != "fft")
			throw new ArgumentException($"Invalid mode {mode}");
		_state.TimeMode = mode;
	}

	public void SetFFTBinCount(int length)
	{
		lock (_fftStorage)
		{
			_state.FFTLength = length;
			ResetFFTStorage();
		}
	}

	public void SetAveragingMode(string mode)
	{
		if (mode != "prefer-data" && mode != "prefer-display")
			throw new ArgumentException($"Invalid mode {mode}");
		_state.FFTAveragingMode = mode;
		ResetFFTStorage();
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

	public override object? OnSave(ZipArchive archive, string deviceId)
	{
		if (_dt == 0) return null;
		var wasRunning = _state.Running;
		if (wasRunning) Stop();
		Thread.Sleep(10);
		var traceLength = -1;
		for (var ch = 0; ch < _state.Channels.Length; ch++)
		{
			if (!_state.Channels[ch].ChannelActive) continue;

			var trace = _buffer[ch].ToArray(readPastTail: true);
			if (traceLength == -1) traceLength = trace.Length;
			if (traceLength != trace.Length) throw new Exception("The traces should all have the same length.");
			using (var traceFile = archive.CreateEntry($"{deviceId}_C{ch + 1}").Open())
			{
				np.Save(trace, traceFile);
			}

			using (var fftFile = archive.CreateEntry($"{deviceId}_F{ch + 1}").Open())
			{
				np.Save(_fftStorage[ch].astype(NPTypeCode.Single).ToArray<float>(), fftFile);
			}

		}
		if (traceLength == -1) return null;

		var t = Enumerable.Range(0, traceLength).Select(i => (float)(i * _dt)).ToArray();
		using (var tFile = archive.CreateEntry($"{deviceId}_t").Open())
		{
			np.Save(t, tFile);
		}

		var df = _state.FFTFrequency / (_state.FFTLength / 2 + 1);
		var f = Enumerable.Range(0, _state.FFTLength / 2 + 1).Select(i => (float)(i * _df)).ToArray();
		using (var fFile = archive.CreateEntry($"{deviceId}_f").Open())
		{
			np.Save(f, fFile);
		}

		if (wasRunning) Start();

		return new { dt = _dt, df = _df };
	}

	protected int _runId = 0;
	virtual public void Start()
	{
		_runId++;
		var localRunId = _runId;
		ResetFFTStorage();

		_state.Running = true;

		Task.Run(() =>
		{
			while (_state.Running && _runId == localRunId)
			{
				Thread.Sleep(1);
				bool didSomeWork;
				lock (_fftStorage)
				{
					var length = _state.FFTLength;
					var fft = new float[length + 2];
					for (var i = 0; i < 500_000; i += length)
					{
						didSomeWork = false;
						var prefersDisplayMode = _state.FFTAveragingMode == "prefer-display";
						for (var ch = 0; ch < 4; ch++)
						{
							if (_state.Channels[ch].ChannelActive && _buffer[ch].Count > length)
							{
								didSomeWork = true;
								_buffer[ch].Pop(length, fft);
								var fftNp = np.array(fft);
								if (_state.FFTWindowFunction != "rectangular")
								{
									fftNp = fftNp * _fftWindowFunction;
								}
								fft = fftNp.ToArray<float>();
								Fourier.ForwardReal(fft, length);
								fftNp = np.array(fft);
								var newWeight = 1.0 / (_acquiredFFTs[ch] + 1);
								if (_state.FFTAveragingDurationInMilliseconds == 0)
								{
									newWeight = 1.0;
								}
								else if (_state.FFTAveragingDurationInMilliseconds > 0)
								{
									newWeight = Math.Max(newWeight, 1 - (double)Math.Exp(-_dt * length / _state.FFTAveragingDurationInMilliseconds * 1000));
								}
								var oldWeight = 1.0 - newWeight;
								var fftReal = fftNp["::2"];
								var fftImag = fftNp["1::2"];
								var val = (np.square(fftReal) + np.square(fftImag)).astype(NPTypeCode.Double);
								val *= 1 / _df;

								if (prefersDisplayMode)
								{
									val = np.log10(val) * 10;
								}

								_fftStorage[ch] = _fftStorage[ch] * oldWeight + val * newWeight;
								_acquiredFFTs[ch]++;
							}
						}
						if (!didSomeWork || !_state.Running || _runId != localRunId) break;
					}
				}
			}
		});

		Task.Run(() =>
		{
			DateTime lastTransmission = DateTime.MinValue;
			while (_state.Running && _runId == localRunId)
			{
				if (DateTime.UtcNow - lastTransmission < TimeSpan.FromSeconds(1.0 / 30))
				{
					Thread.Sleep(5);
					continue;
				}
				var channelData = new float[_state.Channels.Length][];
				double xMax = 0;
				int length = 0;
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
						xMax = _dt * (_state.FFTLength - 1);
						length = _state.FFTLength;
						break;
					case "fft":
						var preferDisplay = _state.FFTAveragingMode == "prefer-display";
						for (var ch = 0; ch < channelData.Length; ch++)
						{
							if (_state.Channels[ch].ChannelActive)
							{
								var storage = np.array(_fftStorage[ch]);

								if (preferDisplay) channelData[ch] = storage.ToArray<float>();
								else channelData[ch] = (np.log10(storage) * 10).astype(NPTypeCode.Float).ToArray<float>();
							}
						}
						xMax = 1 / (2 * _dt);
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
				lastTransmission = DateTime.UtcNow;
			}
		});
	}

	virtual public void Stop()
	{
		_state.Running = false;
	}

	virtual public void SetCoupling(int channel, string coupling)
	{
		if (coupling != "AC" && coupling != "DC")
			throw new ArgumentException($"Invalid mode {coupling}");
		_state.Channels[channel].Coupling = coupling;
	}

	virtual public void SetTestSignalFrequency(float frequency)
	{
		_state.TestSignalFrequency = frequency;
	}

	public override void Dispose()
	{
		_state.Running = false;
	}
}
