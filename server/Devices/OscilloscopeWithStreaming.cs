#define _WINDOWS
using NumSharp;
using System.Numerics;
using System.Numerics.Tensors;
using System.Runtime.Intrinsics.X86;
using System.Runtime.Intrinsics;
using System.Runtime.InteropServices;

#if _WINDOWS
using PetterPet.FFTSSharp;
#else
using Accord.Math.Transforms;
#endif

public class OscilloscopeStreamData
{
	// The padding is required to make the data align with the 32-bit boundary
	public byte _Padd { get; set; }
	// Important for alignment: No other porperties should be before _Padding/Data
	public required byte[] Data { get; set; }
	public required int[] ChannelsInData { get; set; }
	public required float XMin { get; set; }
	public required float XMax { get; set; }
	public float XMinDecimated { get; set; } = 0f;
	public float XMaxDecimated { get; set; } = 0f;
	public required string Mode { get; set; }
	public required int Length { get; set; }
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
	protected CircularBuffer<float>[] RecordingBuffer = [new(10_000_000), new(10_000_000), new(10_000_000), new(10_000_000)];
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
		FFTLock.EnterWriteLock();
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
			case "blackman-nuttall":
                for (int n = 0; n < length; n++)
                    FFTWindowFunction[n] = (float)(0.3635819 - 0.4891775 * Math.Cos(2 * Math.PI * n / N) + 0.1365995 * Math.Cos(4 * Math.PI * n / N) - 0.0106411 * Math.Cos(6 * Math.PI * n / N));
                break;
            default:
				throw new ArgumentException($"Invalid window function {State.FFTWindowFunction}");
		}
		var norm = TensorPrimitives.Norm(FFTWindowFunction);
		var normalizationFactor = length / norm;
		TensorPrimitives.Multiply(FFTWindowFunction, normalizationFactor, FFTWindowFunction);
	}

	public void SetDisplayMode(string mode)
	{
		if (mode != "time" && mode != "fft")
			throw new ArgumentException($"Invalid mode {mode}");
		State.DisplayMode = mode;
	}

	public void SetFFTBinCount(int length)
	{
		FFTLock.EnterWriteLock();
		try
		{
			State.FFTLength = length;
			Df = 1 / (2 * Dt) / (State.FFTLength / 2);
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
		FFTLock.EnterWriteLock();
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

	public override object? OnSaveSnapshot(Func<string, Stream>? getStream, string deviceId)
	{
		if (Dt == 0) return null;

		var returnObject = new { dt = Dt, df = Df };
		if (getStream == null) return returnObject;

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
			TensorPrimitives.ConvertChecked<double, float>(FFTStorage[ch], buffer);
			if (!preferDisplay)
			{
				TensorPrimitives.Log10<float>(buffer, buffer);
				TensorPrimitives.Multiply(buffer, 10, buffer);
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

		return returnObject;
	}

	protected bool IsRecording = false;
	private NPYStreamWriter<float>[]? RecordingStreams = null;
	public override Task OnRecord(Func<string, Stream> getStream, string deviceId, CancellationToken cancellationToken)
	{
		if (Dt == 0 || !State.Running) return Task.CompletedTask;

		RecordingStreams = new NPYStreamWriter<float>[State.Channels.Length];
		for (var ch = 0; ch < State.Channels.Length; ch++)
		{
			RecordingBuffer[ch].Clear();
			if (!State.Channels[ch].ChannelActive) continue;
			RecordingStreams[ch] = new NPYStreamWriter<float>(getStream($"{deviceId}_C{ch + 1}"), false);
		}
		IsRecording = true;

		var delayedCancellationSource = new CancellationTokenSource();
		cancellationToken.Register(async () =>
		{
			IsRecording = false;
			await Task.Delay(10); // In order to easily prevent race conditions
			delayedCancellationSource.Cancel();
		});

		return Task.Run(() =>
		{
			try
			{
				Task.WaitAll(State.Channels.Select((channel, ch) => Task.Run(() =>
				{
					if (!channel.ChannelActive) return;
					while (!delayedCancellationSource.IsCancellationRequested)
					{
						if (RecordingBuffer[ch].Count < 300_000)
						{
							// we want to write large chunks in order to maintain an efficient data transfer to disk
							Thread.Sleep(1);
							continue;
						}
						if (RecordingBuffer[ch].Count > 0.9 * RecordingBuffer[ch].Capacity)
						{
							Console.WriteLine("Recording buffer is full. Stopping recording.");
							delayedCancellationSource.Cancel();
							throw new Exception("Recording buffer is full. This should not happen.");
						}
						RecordingStreams[ch].WriteArray(
							RecordingBuffer[ch].Pop(RecordingBuffer[ch].Count)
						);
					}
					// after stopping the recording, dump the recording buffer one final time
					if (RecordingBuffer[ch].Count > 0)
					{
						RecordingStreams[ch].WriteArray(
							RecordingBuffer[ch].Pop(RecordingBuffer[ch].Count)
						);
					}
				})).ToArray());
			}
			finally
			{
				var streamSizes = RecordingStreams.Where(s => s != null).Select((s) => s.BaseStream.Length).ToArray();
				if (streamSizes.Length > 1 && !streamSizes.Skip(1).All((size) => size == streamSizes[0]))
				{
					Console.WriteLine($"Warning while saving recording: recording sizes of the different channels don't match: {string.Join(", ", streamSizes)}");
				}
				foreach (var stream in RecordingStreams)
				{
					stream?.Dispose();
				}
				RecordingStreams = null;
				Start();
			}
			var buffer = new float[State.FFTLength / 2 + 1];
			for (var ch = 0; ch < State.Channels.Length; ch++)
			{
				if (!State.Channels[ch].ChannelActive) continue;
				var fftFile = getStream($"{deviceId}_F{ch + 1}");
				var preferDisplay = State.FFTAveragingMode == "prefer-display";

				TensorPrimitives.ConvertChecked<double, float>(FFTStorage[ch], buffer);
				if (!preferDisplay)
				{
					TensorPrimitives.Log10<float>(buffer, buffer);
					TensorPrimitives.Multiply(buffer, 10, buffer);
				}
				np.Save(buffer, fftFile);
			}
		});
	}

	private CancellationTokenSource? runCancellationTokenSource = null;
	public void Start()
	{
		if (State.Running) return;
		runCancellationTokenSource = new();
		ResetFFTStorage();
		foreach (var buffer in Buffer) buffer.Clear();

		State.Running = true;

		OnStart(runCancellationTokenSource.Token);
		Df = 1 / (2 * Dt) / (State.FFTLength / 2);

		Task.Run(() =>
		{
			var token = runCancellationTokenSource.Token;
			while (true)
			{
				var length = State.FFTLength;
				var fftFactor = (float)(2 * Dt / length);
				var fftData = new float[length];
				var fftDataDouble = new double[length / 2 + 1];
				var fftOut = new float[length + 2];
#if _WINDOWS
				var ffts = FFTS.Real(FFTS.Forward, length);

				var indicesEven512 = Vector512.Create(0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30);
				var indicesOdd512 = Vector512.Create(1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31);
				var vFFTFactor512 = Vector512.Create(fftFactor);
				var indicesEven256 = Vector256.Create(0, 2, 4, 6, 0, 2, 4, 6);
				var indicesOdd256 = Vector256.Create(1, 3, 5, 7, 1, 3, 5, 7);
				var vFFTFactor256 = Vector256.Create(fftFactor);
#else
				var fftComplex = new Complex[length];
#endif
				while (true)
				{
					if (token.IsCancellationRequested) return;

					FFTLock.EnterReadLock();
					if (State.FFTLength != length)
					{
						FFTLock.ExitReadLock();
						break;
					}
					var didWork = false;
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
									didWork = true;
									Buffer[ch].Pop(length, fftData);
									TensorPrimitives.Multiply(fftData, FFTWindowFunction, fftData);
#if _WINDOWS
									ffts.Execute(fftData, fftOut);

									{
										if (Avx512F.IsSupported)
										{
											var vectors = MemoryMarshal.Cast<float, Vector512<float>>(fftOut);
											for (int j = 0; j < vectors.Length / 2; j++)
											{
												var v1 = vectors[j * 2];
												var v2 = vectors[j * 2 + 1];
												var vReal = Avx512F.PermuteVar16x32x2(v1, indicesEven512, v2);
												var vImag = Avx512F.PermuteVar16x32x2(v1, indicesOdd512, v2);
												var vMagnitudeSquared = Avx512F.FusedMultiplyAdd(vReal, vReal, Avx512F.Multiply(vImag, vImag));
												vMagnitudeSquared = Avx512F.Multiply(vMagnitudeSquared, vFFTFactor512);
												vMagnitudeSquared.CopyTo(fftData, j * Vector512<float>.Count);
											}
											for (var k = vectors.Length / 2 * Vector512<float>.Count; k < fftOut.Length; k += 2)
											{
												fftData[k / 2] = (fftOut[k] * fftOut[k] + fftOut[k + 1] * fftOut[k + 1]) * fftFactor;
											}
										}
										else if(Avx2.IsSupported) {
											var vectors = MemoryMarshal.Cast<float, Vector256<float>>(fftOut);
											for (int j = 0; j < vectors.Length / 2; j++)
											{
												var v1 = vectors[j * 2];
												var v2 = vectors[j * 2 + 1];
												var v1Even = Avx2.PermuteVar8x32(v1, indicesEven256);
												var v2Even = Avx2.PermuteVar8x32(v2, indicesEven256);
												var v1Odd = Avx2.PermuteVar8x32(v1, indicesOdd256);
												var v2Odd = Avx2.PermuteVar8x32(v2, indicesOdd256);
												var vReal = Avx.Blend(v1Even, v2Even, 0xF0);
												var vImag = Avx.Blend(v1Odd, v2Odd, 0xF0);
												var vMagnitudeSquared = Fma.MultiplyAdd(vReal, vReal, Avx.Multiply(vImag, vImag));
												vMagnitudeSquared = Avx.Multiply(vMagnitudeSquared, vFFTFactor256);
												vMagnitudeSquared.CopyTo(fftData, j * Vector256<float>.Count);
											}
											for (var k = vectors.Length / 2 * Vector256<float>.Count; k < fftOut.Length; k += 2)
											{
												fftData[k / 2] = (fftOut[k] * fftOut[k] + fftOut[k + 1] * fftOut[k + 1]) * fftFactor;
											}
										}
										else {
											Parallel.For(0, length / 2 + 1, j => { fftData[j] = (fftOut[2 * j] * fftOut[2 * j] + fftOut[2 * j + 1] * fftOut[2 * j + 1]) * fftFactor; });
										}
									}
#else
									for (var j = 0; j < length; j++) fftComplex[j] = fftData[j];
									FourierTransform2.FFT(fftComplex, Accord.Math.FourierTransform.Direction.Forward);
									for (var j = 0; j < length / 2 + 1; j++) fftData[j] = (float)(fftComplex[j].Real * fftComplex[j].Real + fftComplex[j].Imaginary * fftComplex[j].Imaginary) * fftFactor;
#endif
									var cutFFTData = fftData.AsSpan(0, length / 2 + 1);
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
										// for (var j = 0; j < length / 2 + 1; j++) fftData[j] = (float)Math.Log10(fftData[j]) * 10;
										TensorPrimitives.Log10<float>(cutFFTData, cutFFTData);
										TensorPrimitives.Multiply(cutFFTData, 10, cutFFTData);
									}
									var storage = FFTStorage[ch];
									// for (var j = 0; j < length / 2 + 1; j++) { storage[j] = storage[j] * oldWeight + fftData[j] * newWeight; }
									TensorPrimitives.ConvertChecked<float, double>(cutFFTData, fftDataDouble);
									TensorPrimitives.Multiply(storage, oldWeight, storage);
									TensorPrimitives.Multiply(fftDataDouble, newWeight, fftDataDouble);
									TensorPrimitives.Add<double>(storage, fftDataDouble, storage);
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
					if (!didWork) Thread.Sleep(1);
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
					FFTLock.EnterReadLock();
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
										TensorPrimitives.ConvertChecked<double, float>(FFTStorage[ch], channelData[ch]);
										if (!preferDisplay)
										{
											TensorPrimitives.Log10<float>(channelData[ch], channelData[ch]);
											TensorPrimitives.Multiply(channelData[ch], 10, channelData[ch]);
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
							var activeChannels = 0;
							var reducedData = data.Data.Select((d, i) =>
							{
								if (d == null || !State.Channels[i].ChannelActive) return null;
								var decimation = SignalUtils.DecimateSignal(d, data.XMin, data.XMax, xMinWish, xMaxWish, 2000);
								xMin = decimation.xMin;
								xMax = decimation.xMax;
								length = decimation.signal.Length;
								activeChannels++;
								return decimation.signal;
							}).ToArray();
							var buffer = new byte[length * sizeof(float) * activeChannels];
							var offset = 0;
							foreach (var floatArray in reducedData.Where(d => d != null))
							{
								System.Buffer.BlockCopy(floatArray!, 0, buffer, offset * length * sizeof(float), length * sizeof(float));
								offset++;
							}
							return new OscilloscopeStreamData
							{
								XMin = data.XMin,
								XMax = data.XMax,
								XMinDecimated = xMin,
								XMaxDecimated = xMax,
								Data = buffer,
								ChannelsInData = reducedData.Select((d, i) => d == null ? -1 : i).Where(i => i != -1).ToArray(),
								Mode = data.Mode,
								Length = length,
							};
						}, new { XMin = 0f, XMax = (float)xMax, Mode = State.DisplayMode, Length = length, Data = channelData });
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

	public float[][] GetFFT(int channel, float fMin, float fMax)
	{
		if (!State.Running || Df == 0) return [[], []];
		FFTLock.EnterReadLock();
		try
		{
			var iMin = fMin == 0 ? 0 : (int)Math.Ceiling(fMin / Df);
			var iMax = fMax == 0 ? State.FFTLength / 2 + 1 : (int)Math.Floor(fMax / Df);
			var f = new float[iMax - iMin + 1];
			var psd = new float[iMax - iMin + 1];
			for (var i = 0; i <= iMax - iMin; i++)
			{
				f[i] = (float)((i + iMin) * Df);
			}
			var preferDisplay = State.FFTAveragingMode == "prefer-display";
			if (preferDisplay)
			{
				for (var i = 0; i <= iMax - iMin; i++)
				{
					psd[i] = (float)FFTStorage[channel][i + iMin];
				}
			}
			else
			{
				for (var i = 0; i <= iMax - iMin; i++)
				{
					psd[i] = (float)Math.Log10(FFTStorage[channel][i + iMin]) * 10;
				}
			}
			return [f, psd];
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
		runCancellationTokenSource?.Cancel();
	}
}
