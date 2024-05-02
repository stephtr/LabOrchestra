using NumSharp;
using PetterPet.FFTSSharp;
using System.IO.Compression;

public class OscilloscopeStreamData
{
	public required float XMin { get; set; }
	public required float XMax { get; set; }
	public float XMinDecimated { get; set; } = 0f;
	public float XMaxDecimated { get; set; } = 0f;
	public required string Mode { get; set; }
	public required int Length { get; set; }
	public required float[]?[] Data { get; set; }
}

public class OscilloscopeWithStreaming : DeviceHandlerBase<OscilloscopeState>, IOscilloscope
{
	protected CircularBuffer<float>[] _buffer = [new(100_000_000), new(100_000_000), new(100_000_000), new(100_000_000)];
	protected double[][] _fftStorage = [Array.Empty<double>(), Array.Empty<double>(), Array.Empty<double>(), Array.Empty<double>()];
	protected float[] _fftWindowFunction = Array.Empty<float>();
	protected int[] _acquiredFFTs = { 0, 0, 0, 0 };
	protected double _dt = 0;
	protected double _df = 0;

	public OscilloscopeWithStreaming()
	{
		FFTSManager.LoadAppropriateDll(FFTSManager.InstructionType.Auto);
	}

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
		lock (_fftStorage)
		{
			for (int i = 0; i < _fftStorage.Length; i++)
				_fftStorage[i] = new double[_state.FFTLength / 2 + 1];
			_acquiredFFTs = [0, 0, 0, 0];
			_fftWindowFunction = new float[_state.FFTLength];
			ResetFFTWindow();
		}
	}

	protected void ResetFFTWindow()
	{
		var length = _state.FFTLength;
		var N = _state.FFTLength - 1;
		switch (_state.FFTWindowFunction)
		{
			case "rectangular":
				for (int n = 0; n < length; n++)
					_fftWindowFunction[n] = 1;
				break;
			case "hann":
				for (int n = 0; n < length; n++)
				{
					var sin = Math.Sin(Math.PI * n / N);
					_fftWindowFunction[n] = (float)(sin * sin);
				}
				break;
			case "blackman":
				for (int n = 0; n < length; n++)
					_fftWindowFunction[n] = (float)(0.42 - 0.5 * Math.Cos(2 * Math.PI * n / N) + 0.08 * Math.Cos(4 * Math.PI * n / N));
				break;
			case "nuttall":
				for (int n = 0; n < length; n++)
					_fftWindowFunction[n] = (float)(0.355768 - 0.487396 * Math.Cos(2 * Math.PI * n / N) + 0.144232 * Math.Cos(4 * Math.PI * n / N) - 0.012604 * Math.Cos(6 * Math.PI * n / N));
				break;
			default:
				throw new ArgumentException($"Invalid window function {_state.FFTWindowFunction}");
		}
		var sum = 0f;
		for (int n = 0; n < length; n++)
		{
			sum += _fftWindowFunction[n];
		}
		var normalizationFactor = length / sum;
		for (int n = 0; n < length; n++)
		{
			_fftWindowFunction[n] *= normalizationFactor;
		}
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
		lock (_fftStorage)
		{
			_state.FFTWindowFunction = windowFuction;
			ResetFFTWindow();
		}
	}

	private bool WasRunningBeforeSnapshot = false;
	public override void OnBeforeSaveSnapshot()
	{
		WasRunningBeforeSnapshot = _state.Running;
		Stop();
	}

	public override void OnAfterSaveSnapshot()
	{
		if (WasRunningBeforeSnapshot) Start();
	}

	public override object? OnSaveSnapshot(ZipArchive archive, string deviceId)
	{
		if (_dt == 0) return null;
		var wasRunning = _state.Running;
		if (wasRunning) Stop();
		Thread.Sleep(10);
		var traceLength = -1;
		for (var ch = 0; ch < _state.Channels.Length; ch++)
		{
			if (!_state.Channels[ch].ChannelActive) continue;

			var hasBufferRolledOver = _buffer[ch].HasRolledOver;
			var pointsToRead = Math.Min(hasBufferRolledOver ? _buffer[ch].Capacity : _buffer[ch].Count, _state.DatapointsToSnapshot);
			var trace = _buffer[ch].PeekHead(pointsToRead, readPastTail: hasBufferRolledOver);
			if (traceLength == -1) traceLength = trace.Length;
			if (traceLength != trace.Length) throw new Exception("The traces should all have the same length.");
			using (var traceFile = archive.CreateEntry($"{deviceId}_C{ch + 1}").Open())
			{
				np.Save(trace, traceFile);
			}

			using (var fftFile = archive.CreateEntry($"{deviceId}_F{ch + 1}").Open())
			{
				np.Save(Array.ConvertAll(_fftStorage[ch], Convert.ToSingle), fftFile);
			}

		}
		if (traceLength == -1) return null;

		var t = Enumerable.Range(0, traceLength).Select(i => (float)(i * _dt)).ToArray();
		using (var tFile = archive.CreateEntry($"{deviceId}_t").Open())
		{
			np.Save(t, tFile);
		}

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
			while (true)
			{
				var length = _state.FFTLength;
				var fftFactor = (float)(2 * _dt / length);
				var fftIn = new float[length];
				var fftOut = new float[length + 2];
				var ffts = FFTS.Real(FFTS.Forward, length);
				while (_state.FFTLength == length)
				{
					Thread.Sleep(1);
					bool didSomeWork;
					if (!_state.Running || _runId != localRunId) return;
					lock (_fftStorage)
					{
						// let's do a loop such that we don't have to constantly re-lock
						for (var i = 0; i < 500_000; i += length)
						{
							didSomeWork = false;
							var prefersDisplayMode = _state.FFTAveragingMode == "prefer-display";
							for (var ch = 0; ch < 4; ch++)
							{
								if (_state.Channels[ch].ChannelActive && _buffer[ch].Count > length)
								{
									didSomeWork = true;
									_buffer[ch].Pop(length, fftIn);
									for (var j = 0; j < length; j++) fftIn[j] *= _fftWindowFunction[j];
									ffts.Execute(fftIn, fftOut);

									for (var j = 0; j < length / 2 + 1; j++) fftOut[j] = (fftOut[2 * j] * fftOut[2 * j] + fftOut[2 * j + 1] * fftOut[2 * j + 1]) * fftFactor;
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

									if (prefersDisplayMode)
									{
										for (var j = 0; j < length / 2 + 1; j++)
											fftOut[j] = (float)Math.Log10(fftOut[j]) * 10;
									}
									var storage = _fftStorage[ch];
									for (var j = 0; j < length / 2 + 1; j++) storage[j] = storage[j] * oldWeight + fftOut[j] * newWeight;
									_acquiredFFTs[ch]++;
								}
							}
							if (!didSomeWork || !_state.Running || _runId != localRunId) break;
						}
					}
				}
			}
		});

		Task.Run(() =>
		{
			var getSignalLength = () => _state.TimeMode switch
				{
					"time" => _state.FFTLength,
					"fft" => _state.FFTLength / 2 + 1,
					_ => throw new ArgumentException($"Invalid time mode {_state.TimeMode}")
				};
			while (true)
			{
				var length = getSignalLength();
				var channelData = new float[_state.Channels.Length][];
				for (var i = 0; i < channelData.Length; i++)
				{
					channelData[i] = new float[length];
				}

				DateTime lastTransmission = DateTime.MinValue;
				while (length == getSignalLength())
				{
					if (DateTime.UtcNow - lastTransmission < TimeSpan.FromSeconds(1.0 / 30))
					{
						Thread.Sleep(5);
						continue;
					}
					if (!_state.Running || _runId != localRunId) return;
					double xMax = 0;
					switch (_state.TimeMode)
					{
						case "time":
							for (var ch = 0; ch < channelData.Length; ch++)
							{
								if (_state.Channels[ch].ChannelActive)
								{
									_buffer[ch].PeekHead(_state.FFTLength, channelData[ch], readPastTail: true);
								}
							}
							xMax = _dt * (_state.FFTLength - 1);
							break;
						case "fft":
							var preferDisplay = _state.FFTAveragingMode == "prefer-display";
							for (var ch = 0; ch < channelData.Length; ch++)
							{
								if (_state.Channels[ch].ChannelActive)
								{
									if (preferDisplay)
									{
										for (var j = 0; j < length; j++)
											channelData[ch][j] = (float)_fftStorage[ch][j];
									}
									else
									{
										for (var j = 0; j < length; j++)
										{
											channelData[ch][j] = (float)Math.Log10(_fftStorage[ch][j]) * 10;
										}
									}
								}
							}
							xMax = 1 / (2 * _dt);
							break;
					}
					_deviceManager?.SendStreamData(_deviceManager.GetDeviceId(this), (data, customization) =>
					{
						var xMinWish = customization == null ? data.XMin : Convert.ToSingle(customization["xMin"]);
						var xMaxWish = customization == null ? data.XMax : Convert.ToSingle(customization["xMax"]);
						var xMin = 0f;
						var xMax = 0f;
						var length = 0;
						var reducedData = data.Data.Select((d, i) =>
						{
							if (d == null || !_state.Channels[i].ChannelActive || customization == null) return null;
							var decimation = SignalUtils.DecimateSignal(d, data.XMin, data.XMax, xMinWish, xMaxWish, 1500);
							xMin = decimation.xMin;
							xMax = decimation.xMax;
							length = decimation.signal.Length;
							return decimation.signal;
						}).ToArray();
						return new OscilloscopeStreamData
						{
							XMin = data.XMin,
							XMax = data.XMax,
							XMinDecimated = xMin,
							XMaxDecimated = xMax,
							Mode = data.Mode,
							Length = length,
							Data = reducedData
						};
					}, new OscilloscopeStreamData { XMin = 0f, XMax = (float)xMax, Mode = _state.TimeMode, Length = length, Data = channelData });
					lastTransmission = DateTime.UtcNow;
				}
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

	public void SetDatapointsToSnapshot(int datapoints)
	{
		_state.DatapointsToSnapshot = datapoints;
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
