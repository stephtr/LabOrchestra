using NumSharp;
using System.Numerics;

#if _WINDOWS
using PetterPet.FFTSSharp;
#else
using Accord.Math.Transforms;
#endif

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

public class OscilloscopeFFTData
{
	public required double fMin { get; set; }
	public required double fMax { get; set; }
	public required float[][] data { get; set; }
}

public abstract class OscilloscopeWithStreaming : DeviceHandlerBase<OscilloscopeState>, IOscilloscope
{
	protected CircularBuffer<float>[] Buffer = [new(100_000_000), new(100_000_000), new(100_000_000), new(100_000_000)];
	protected double[][] FFTStorage = [Array.Empty<double>(), Array.Empty<double>(), Array.Empty<double>(), Array.Empty<double>()];
	protected float[] FFTWindowFunction = Array.Empty<float>();
	protected int[] AcquiredFFTs = { 0, 0, 0, 0 };
	protected double Dt = 0;
	protected double Df = 0;
	private ReaderWriterLockSlim FFTLock = new();

	public OscilloscopeWithStreaming()
	{
#if _WINDOWS
			FFTSManager.LoadAppropriateDll(FFTSManager.InstructionType.Auto);
#endif
	}

	virtual public void SetRange(int channel, int rangeInMillivolts)
	{
		State.Channels[channel].RangeInMillivolts = rangeInMillivolts;
	}

	virtual public void SetChannelActive(int channel, bool active)
	{
		State.Channels[channel].ChannelActive = active;
	}

	public void SetFFTFrequency(float freq)
	{
		var wasRunning = State.Running;
		if (wasRunning)
		{
			Stop();
		}
		FFTLock.TryEnterWriteLock(-1);
		try
		{
			State.FFTFrequency = freq;
		}
		finally
		{
			FFTLock.ExitWriteLock();
		}
		if (wasRunning)
		{
			Start();
		}
	}

	public void ResetFFTStorage()
	{
		for (int i = 0; i < FFTStorage.Length; i++)
			FFTStorage[i] = new double[State.FFTLength / 2 + 1];
		AcquiredFFTs = [0, 0, 0, 0];
		FFTWindowFunction = new float[State.FFTLength];
		ResetFFTWindow();
	}

	protected void ResetFFTWindow()
	{
		var length = State.FFTLength;
		var N = State.FFTLength - 1;
		switch (State.FFTWindowFunction)
		{
			case "rectangular":
				for (int n = 0; n < length; n++)
					FFTWindowFunction[n] = 1;
				break;
			case "hann":
				for (int n = 0; n < length; n++)
				{
					var sin = Math.Sin(Math.PI * n / N);
					FFTWindowFunction[n] = (float)(sin * sin);
				}
				break;
			case "blackman":
				for (int n = 0; n < length; n++)
					FFTWindowFunction[n] = (float)(0.42 - 0.5 * Math.Cos(2 * Math.PI * n / N) + 0.08 * Math.Cos(4 * Math.PI * n / N));
				break;
			case "nuttall":
				for (int n = 0; n < length; n++)
					FFTWindowFunction[n] = (float)(0.355768 - 0.487396 * Math.Cos(2 * Math.PI * n / N) + 0.144232 * Math.Cos(4 * Math.PI * n / N) - 0.012604 * Math.Cos(6 * Math.PI * n / N));
				break;
			default:
				throw new ArgumentException($"Invalid window function {State.FFTWindowFunction}");
		}
		var sum = 0f;
		for (int n = 0; n < length; n++)
		{
			sum += FFTWindowFunction[n] * FFTWindowFunction[n];
		}
		var normalizationFactor = length / (float)Math.Sqrt(sum);
		for (int n = 0; n < length; n++)
		{
			FFTWindowFunction[n] *= normalizationFactor;
		}
	}

	public void SetDisplayMode(string mode)
	{
		if (mode != "time" && mode != "fft")
			throw new ArgumentException($"Invalid mode {mode}");
		State.DisplayMode = mode;
	}

	public void SetFFTBinCount(int length)
	{
		FFTLock.TryEnterWriteLock(-1);
		try
		{
			State.FFTLength = length;
			ResetFFTStorage();
		}
		finally
		{
			FFTLock.ExitWriteLock();
		}
	}

	public void SetAveragingMode(string mode)
	{
		if (mode != "prefer-data" && mode != "prefer-display")
			throw new ArgumentException($"Invalid mode {mode}");
		State.FFTAveragingMode = mode;
		ResetFFTStorage();
	}

	public void SetFFTAveragingDuration(int durationInMilliseconds)
	{
		State.FFTAveragingDurationInMilliseconds = durationInMilliseconds;
	}

	public void SetFFTWindowFunction(string windowFuction)
	{
		FFTLock.TryEnterWriteLock(-1);
		try
		{
			State.FFTWindowFunction = windowFuction;
			ResetFFTWindow();
		}
		finally
		{
			FFTLock.ExitWriteLock();
		}
	}

	private bool WasRunningBeforeSnapshot = false;
	public override void OnBeforeSaveSnapshot()
	{
		WasRunningBeforeSnapshot = State.Running;
		Stop();
	}

	public override void OnAfterSaveSnapshot()
	{
		if (WasRunningBeforeSnapshot) Start();
	}

	public override object? OnSaveSnapshot(Func<string, Stream> getStream, string deviceId)
	{
		if (Dt == 0) return null;
		var wasRunning = State.Running;
		if (wasRunning) Stop();
		Thread.Sleep(10);
		var traceLength = -1;
		var buffer = new float[State.FFTLength / 2 + 1];
		for (var ch = 0; ch < State.Channels.Length; ch++)
		{
			if (!State.Channels[ch].ChannelActive) continue;

			var hasBufferRolledOver = Buffer[ch].HasRolledOver;
			var pointsToRead = Math.Min(Buffer[ch].CountIncludingAlreadyReadItems, State.DatapointsToSnapshot);
			var trace = Buffer[ch].PeekHead(pointsToRead, readPastTail: true);
			if (traceLength == -1) traceLength = trace.Length;
			if (traceLength != trace.Length) throw new Exception("The traces should all have the same length.");

			var traceFile = getStream($"{deviceId}_C{ch + 1}");
			np.Save(trace, traceFile);

			var fftFile = getStream($"{deviceId}_F{ch + 1}");
			var preferDisplay = State.FFTAveragingMode == "prefer-display";
			if (preferDisplay)
			{
				for (var j = 0; j < FFTStorage[ch].Length; j++)
					buffer[j] = (float)FFTStorage[ch][j];
			}
			else
			{
				for (var j = 0; j < FFTStorage[ch].Length; j++)
				{
					buffer[j] = (float)Math.Log10(FFTStorage[ch][j]) * 10;
				}
			}
			np.Save(buffer, fftFile);
		}
		if (traceLength == -1) return null;

		var t = Enumerable.Range(0, traceLength).Select(i => (float)(i * Dt)).ToArray();
		var tFile = getStream($"{deviceId}_t");
		np.Save(t, tFile);

		var f = Enumerable.Range(0, State.FFTLength / 2 + 1).Select(i => (float)(i * Df)).ToArray();
		var fFile = getStream($"{deviceId}_f");
		np.Save(f, fFile);

		if (wasRunning) Start();

		return new { dt = Dt, df = Df };
	}

	private CancellationTokenSource? runCancellationTokenSource = null;
	public void Start()
	{
		if (State.Running) return;
		runCancellationTokenSource = new();
		ResetFFTStorage();

		State.Running = true;

		OnStart(runCancellationTokenSource.Token);

		Task.Run(() =>
		{
			var token = runCancellationTokenSource.Token;
			while (true)
			{
				var length = State.FFTLength;
				var fftFactor = (float)(2 * Dt / length);
				var fftIn = new float[length];
				var fftOut = new float[length + 2];
#if _WINDOWS
				var ffts = FFTS.Real(FFTS.Forward, length);
#else
				var fftComplex = new Complex[length];
#endif
				while (State.FFTLength == length)
				{
					if (token.IsCancellationRequested) return;

					FFTLock.TryEnterReadLock(-1);
					try
					{
						// let's do a loop such that we don't have to constantly re-lock
						for (var i = 0; i < 500_000; i += length)
						{
							var prefersDisplayMode = State.FFTAveragingMode == "prefer-display";
							for (var ch = 0; ch < 4; ch++)
							{
								if (State.Channels[ch].ChannelActive && Buffer[ch].Count > length)
								{
									Buffer[ch].Pop(length, fftIn);
									for (var j = 0; j < length; j++) fftIn[j] *= FFTWindowFunction[j];
#if _WINDOWS
									ffts.Execute(fftIn, fftOut);
									for (var j = 0; j < length / 2 + 1; j++) fftOut[j] = (fftOut[2 * j] * fftOut[2 * j] + fftOut[2 * j + 1] * fftOut[2 * j + 1]) * fftFactor;
#else
									for (var j = 0; j < length; j++) fftComplex[j] = fftIn[j];
									FourierTransform2.FFT(fftComplex, Accord.Math.FourierTransform.Direction.Forward);
									for (var j = 0; j < length / 2 + 1; j++) fftOut[j] = (float)(fftComplex[j].Real * fftComplex[j].Real + fftComplex[j].Imaginary * fftComplex[j].Imaginary) * fftFactor;
#endif
									var newWeight = 1.0 / (AcquiredFFTs[ch] + 1);
									if (State.FFTAveragingDurationInMilliseconds == 0)
									{
										newWeight = 1.0;
									}
									else if (State.FFTAveragingDurationInMilliseconds > 0)
									{
										newWeight = Math.Max(newWeight, 1 - (double)Math.Exp(-Dt * length / State.FFTAveragingDurationInMilliseconds * 1000));
									}
									var oldWeight = 1.0 - newWeight;

									if (prefersDisplayMode)
									{
										for (var j = 0; j < length / 2 + 1; j++)
											fftOut[j] = (float)Math.Log10(fftOut[j]) * 10;
									}
									var storage = FFTStorage[ch];
									for (var j = 0; j < length / 2 + 1; j++) storage[j] = storage[j] * oldWeight + fftOut[j] * newWeight;
									AcquiredFFTs[ch]++;
								}
							}
							if (token.IsCancellationRequested) break;
						}
					}
					finally
					{
						FFTLock.ExitReadLock();
					}
					Thread.Sleep(1);
				}
			}
		});

		Task.Run(() =>
		{
			var token = runCancellationTokenSource.Token;
			var getSignalLength = () => State.DisplayMode switch
				{
					"time" => State.FFTLength,
					"fft" => State.FFTLength / 2 + 1,
					_ => throw new ArgumentException($"Invalid time mode {State.DisplayMode}")
				};
			while (true)
			{
				var length = getSignalLength();
				var channelData = new float[State.Channels.Length][];
				for (var i = 0; i < channelData.Length; i++)
				{
					channelData[i] = new float[length];
				}

				DateTime lastTransmission = DateTime.MinValue;
				while (true)
				{
					if (DateTime.UtcNow - lastTransmission < TimeSpan.FromSeconds(1.0 / 30))
					{
						Thread.Sleep(5);
						continue;
					}
					FFTLock.TryEnterReadLock(-1);
					try
					{
						if (length != getSignalLength()) break;
						if (token.IsCancellationRequested) return;
						double xMax = 0;
						switch (State.DisplayMode)
						{
							case "time":
								for (var ch = 0; ch < channelData.Length; ch++)
								{
									if (State.Channels[ch].ChannelActive)
									{
										Buffer[ch].PeekHead(State.FFTLength, channelData[ch], readPastTail: true);
									}
								}
								xMax = Dt * (State.FFTLength - 1);
								break;
							case "fft":
								var preferDisplay = State.FFTAveragingMode == "prefer-display";
								for (var ch = 0; ch < channelData.Length; ch++)
								{
									if (State.Channels[ch].ChannelActive)
									{
										if (preferDisplay)
										{
											for (var j = 0; j < length; j++)
												channelData[ch][j] = (float)FFTStorage[ch][j];
										}
										else
										{
											for (var j = 0; j < length; j++)
											{
												channelData[ch][j] = (float)Math.Log10(FFTStorage[ch][j]) * 10;
											}
										}
									}
								}
								xMax = 1 / (2 * Dt);
								break;
						}
						DeviceManager?.SendStreamData(DeviceManager.GetDeviceId(this), (data, customization) =>
						{
							var xMinWish = customization == null ? data.XMin : Convert.ToSingle(customization["xMin"]);
							var xMaxWish = customization == null ? data.XMax : Convert.ToSingle(customization["xMax"]);
							var xMin = 0f;
							var xMax = 0f;
							var length = 0;
							var reducedData = data.Data.Select((d, i) =>
							{
								if (d == null || !State.Channels[i].ChannelActive) return null;
								var decimation = SignalUtils.DecimateSignal(d, data.XMin, data.XMax, xMinWish, xMaxWish, 1000);
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
						}, new OscilloscopeStreamData { XMin = 0f, XMax = (float)xMax, Mode = State.DisplayMode, Length = length, Data = channelData });
						lastTransmission = DateTime.UtcNow;
					}
					finally
					{
						FFTLock.ExitReadLock();
					}

				}
			}
		});
	}

	public OscilloscopeFFTData GetFFTData(double fMin, double fMax)
	{
		FFTLock.TryEnterReadLock(-1);
		try
		{
			var iMin = (int)(fMin / Df);
			var iMax = (int)Math.Ceiling(fMax / Df);
			iMin = Math.Max(0, iMin);
			iMax = Math.Min(State.FFTLength / 2, fMax == 0 ? int.MaxValue : iMax);
			fMin = iMin * Df;
			fMax = iMax * Df;
			var preferDisplay = State.FFTAveragingMode == "prefer-display";
			var data = FFTStorage.Select((d, ch) =>
			{
				var dataFrom = d.Skip(iMin).Take(iMax - iMin + 1).ToArray();
				var dataTo = new float[dataFrom.Length];
				if (preferDisplay)
				{
					for (var j = 0; j < dataFrom.Length; j++)
						dataTo[j] = (float)dataFrom[j];
				}
				else
				{
					for (var j = 0; j < dataFrom.Length; j++)
					{
						dataTo[j] = dataFrom[j] == 0 ? (float)dataFrom[j] : (float)Math.Log10(dataFrom[j]) * 10;
					}
				}
				return dataTo;
			}).ToArray();
			return new OscilloscopeFFTData { fMin = fMin, fMax = fMax, data = data };
		}
		finally { FFTLock.ExitReadLock(); }
	}

	abstract protected void OnStart(CancellationToken token);

	virtual public void Stop()
	{
		State.Running = false;
		runCancellationTokenSource?.Cancel();
	}

	virtual public void SetCoupling(int channel, string coupling)
	{
		if (coupling != "AC" && coupling != "DC")
			throw new ArgumentException($"Invalid mode {coupling}");
		State.Channels[channel].Coupling = coupling;
	}

	public void SetDatapointsToSnapshot(int datapoints)
	{
		State.DatapointsToSnapshot = datapoints;
	}

	virtual public void SetTestSignalFrequency(float frequency)
	{
		State.TestSignalFrequency = frequency;
	}

	public override void Dispose()
	{
		State.Running = false;
	}
}
