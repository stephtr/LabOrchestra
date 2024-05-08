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
	public string DisplayMode { get; set; } = "time"; // Default mode is "time"
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
	void SetDisplayMode(string mode);
	void SetFFTBinCount(int length);
	void SetAveragingMode(string mode);
	void SetFFTAveragingDuration(int durationInMilliseconds);
	void SetChannelActive(int channel, bool active);
	void SetRange(int channel, int rangeInMillivolts);
	void ResetFFTStorage();
	void SetFFTWindowFunction(string windowFuction);
	void SetTestSignalFrequency(float frequency);
	void SetCoupling(int channel, string coupling);
	void SetDatapointsToSnapshot(int datapoints);
}

public class OscilloscopeHandler : DeviceHandlerBase<OscilloscopeState>, IOscilloscope
{
	private double[][] FFTStorage = [[], [], [], []];
	private float[] FFTWindowFunction = Array.Empty<float>();
	private float[][] Signal = [[], [], [], []];
	private int[] AcquiredFFTs = { 0, 0, 0, 0 };
	private double UpdateInterval = 50e-3;
	public OscilloscopeHandler()
	{
	}

	public void ResetFFTStorage()
	{
		for (int i = 0; i < FFTStorage.Length; i++)
		{
			FFTStorage[i] = new double[State.FFTLength / 2 + 1];
			Signal[i] = new float[State.FFTLength];
		}
		AcquiredFFTs = [0, 0, 0, 0];
		ResetFFTWindow();
	}

	private void ResetFFTWindow()
	{
		FFTWindowFunction = new float[State.FFTLength];
		var N = State.FFTLength - 1;
		switch (State.FFTWindowFunction)
		{
			case "rectangular":
				for (int i = 0; i < State.FFTLength; i++)
					FFTWindowFunction[i] = 1;
				break;
			case "hann":
				for (int n = 0; n < State.FFTLength; n++)
				{
					var sin = Math.Sin(Math.PI * n / N);
					FFTWindowFunction[n] = (float)(sin * sin);
				}
				break;
			case "blackman":
				for (int n = 0; n < State.FFTLength; n++)
					FFTWindowFunction[n] = (float)(0.42 - 0.5 * Math.Cos(2 * Math.PI * n / N) + 0.08 * Math.Cos(4 * Math.PI * n / N));
				break;
			case "nuttall":
				for (int n = 0; n < State.FFTLength; n++)
					FFTWindowFunction[n] = (float)(0.355768 - 0.487396 * Math.Cos(2 * Math.PI * n / N) + 0.144232 * Math.Cos(4 * Math.PI * n / N) - 0.012604 * Math.Cos(6 * Math.PI * n / N));
				break;
			default:
				throw new ArgumentException($"Invalid window function {State.FFTWindowFunction}");
		}
	}

	public void Start()
	{
		ResetFFTStorage();
		State.Running = true;
		Task.Run(() =>
		{
			while (State.Running)
			{
				try
				{
					DoWork();
					Thread.Sleep((int)(UpdateInterval * 1e3));
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
		State.Running = false;
	}

	public void SetDisplayMode(string mode)
	{
		if (mode != "time" && mode != "fft")
			throw new ArgumentException($"Invalid mode {mode}");
		State.DisplayMode = mode;
	}

	public void SetFFTBinCount(int length)
	{
		if (length < 1)
			throw new ArgumentException($"Invalid length {length}");
		State.FFTLength = length;
		ResetFFTStorage();
	}

	public void SetAveragingMode(string mode)
	{
		if (mode != "prefer-data" && mode != "prefer-display")
			throw new ArgumentException($"Invalid mode {mode}");
		State.FFTAveragingMode = mode;
		ResetFFTStorage();
	}

	public void SetChannelActive(int channel, bool active)
	{
		State.Channels[channel].ChannelActive = active;
		FFTStorage[channel] = new double[State.FFTLength / 2 + 1];
		AcquiredFFTs[channel] = 0;
		Signal[channel] = new float[State.FFTLength];
	}

	public void SetRange(int channel, int rangeInMillivolts)
	{
		State.Channels[channel].RangeInMillivolts = rangeInMillivolts;
	}

	private void DoWork()
	{
		var dt = 1 / State.FFTFrequency * (1 / 2 + 1);
		var df = State.FFTFrequency / (State.FFTLength / 2 + 1);

		if (!State.Running) return;
		var rand = new Random();
		var channelData = new float[State.Channels.Length][];
		for (var ch = 0; ch < channelData.Length; ch++)
		{
			if (State.Channels[ch].ChannelActive)
			{
				for (int i = 0; i < State.FFTLength; i++)
					Signal[ch][i] = rand.NextSingle() * 2 - 1;

				var fft = new float[State.FFTLength + 2];
				Array.Copy(Signal[ch], fft, State.FFTLength);
				if (State.FFTWindowFunction != "rectangular")
				{
					for (int i = 0; i < State.FFTLength; i++)
						fft[i] *= FFTWindowFunction[i];
				}
				Fourier.ForwardReal(fft, State.FFTLength);

				var newWeight = 1.0 / (AcquiredFFTs[ch] + 1);
				if (State.FFTAveragingDurationInMilliseconds == 0)
				{
					newWeight = 1.0;
				}
				else if (State.FFTAveragingDurationInMilliseconds > 0)
				{
					newWeight = Math.Max(newWeight, 1 - Math.Exp(-UpdateInterval / State.FFTAveragingDurationInMilliseconds * 1000));
				}
				var oldWeight = 1.0 - newWeight;
				for (int i = 0; i < State.FFTLength / 2 + 1; i++)
				{
					var val = Convert.ToDouble(fft[i * 2] * fft[i * 2] + fft[i * 2 + 1] * fft[i * 2 + 1]);
					val *= 1 / df;
					if (State.FFTAveragingMode == "prefer-display")
					{
						val = Math.Log10(val) * 10;
					}
					FFTStorage[ch][i] = FFTStorage[ch][i] * oldWeight + val * newWeight;
				}
				AcquiredFFTs[ch]++;

				switch (State.DisplayMode)
				{
					case "time":
						channelData[ch] = Signal[ch];
						break;
					case "fft":
						var data = new float[State.FFTLength / 2 + 1];
						for (int i = 0; i < State.FFTLength / 2 + 1; i++)
							data[i] = Convert.ToSingle(
								State.FFTAveragingMode == "prefer-display" ?
									FFTStorage[ch][i] :
									Math.Log10(FFTStorage[ch][i]) * 10
							);
						channelData[ch] = data;
						break;
				}
			}
		}
		double xMax = 0;
		int length = 0;
		switch (State.DisplayMode)
		{
			case "time":
				xMax = dt * (State.FFTLength - 1);
				length = State.FFTLength;
				break;
			case "fft":
				xMax = 1 / (2 * dt);
				length = State.FFTLength / 2 + 1;
				break;
		}
		DeviceManager?.SendStreamData(DeviceManager.GetDeviceId(this), (data, customization) =>
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
		}, new { XMin = 0f, XMax = (float)xMax, Mode = State.DisplayMode, Length = length, Data = channelData });
	}

	public void SetFFTFrequency(float frequency)
	{
		State.FFTFrequency = frequency;
	}

	public void SetFFTAveragingDuration(int durationInMilliseconds)
	{
		State.FFTAveragingDurationInMilliseconds = durationInMilliseconds;
	}

	public void SetFFTWindowFunction(string windowFuction)
	{
		State.FFTWindowFunction = windowFuction;
		ResetFFTWindow();
	}

	public void SetTestSignalFrequency(float frequency)
	{
		State.TestSignalFrequency = frequency;
	}

	public override object? OnSaveSnapshot(ZipArchive archive, string deviceId)
	{
		var savedAnyTraces = false;
		for (var ch = 0; ch < State.Channels.Length; ch++)
		{
			if (!State.Channels[ch].ChannelActive) continue;

			using (var traceFile = archive.CreateEntry($"{deviceId}_C{ch + 1}").Open())
			{
				np.Save(Signal[ch], traceFile);
			}

			using (var fftFile = archive.CreateEntry($"{deviceId}_F{ch + 1}").Open())
			{
				np.Save(FFTStorage[ch], fftFile);
			}

			savedAnyTraces = true;
		}
		if (!savedAnyTraces) return null;

		var dt = 1 / State.FFTFrequency * (1 / 2 + 1);
		var t = Enumerable.Range(0, State.FFTLength).Select(i => (float)(i * dt)).ToArray();
		using (var tFile = archive.CreateEntry($"{deviceId}_t").Open())
		{
			np.Save(t, tFile);
		}

		var df = State.FFTFrequency / (State.FFTLength / 2 + 1);
		var f = Enumerable.Range(0, State.FFTLength / 2 + 1).Select(i => (float)(i * df)).ToArray();
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
		State.Channels[channel].Coupling = coupling;
	}

	public void SetDatapointsToSnapshot(int datapoints)
	{
		State.DatapointsToSnapshot = datapoints;
	}
}
