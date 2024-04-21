using MathNet.Numerics.IntegralTransforms;

public class OscilloscopeChannel
{
	public bool ChannelActive { get; set; } = false;
	public int RangeInMillivolts { get; set; } = 1000;
}

public class OscilloscopeState
{
	public bool Running { get; set; } = true;
	public string TimeMode { get; set; } = "time"; // Default mode is "time"
	public int FFTLength { get; set; } = 1024;
	public string FFTAveragingMode { get; set; } = "prefer-data";

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
	void ChannelActive(int channel, bool active);
	void UpdateRange(int channel, int rangeInMillivolts);
}

public class OscilloscopeHandler : DeviceHandlerBase<OscilloscopeState>, IOscilloscope
{
	private double[][] _fftStorage = [[], [], [], []];
	private int[] _acquiredFFTs = { 0, 0, 0, 0 };
	private double _dt = 1e-6;
	public OscilloscopeHandler()
	{
		Task.Run(() =>
		{
			while (true)
			{
				try
				{
					DoWork();
					Thread.Sleep(50);
				}
				catch (Exception e)
				{
					Console.WriteLine(e);
				}
			}
		});
	}

	private void ResetFFTStorage()
	{
		for (int i = 0; i < _fftStorage.Length; i++)
			_fftStorage[i] = new double[_state.FFTLength / 2 + 1];
		_acquiredFFTs = [0, 0, 0, 0];
	}

	public void Start()
	{
		_state.Running = true;
		ResetFFTStorage();
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
	}

	public void UpdateRange(int channel, int rangeInMillivolts)
	{
		_state.Channels[channel].RangeInMillivolts = rangeInMillivolts;
	}

	private void DoWork()
	{
		var df = 1 / (_state.FFTLength * _dt);

		if (!_state.Running) return;
		var rand = new Random();
		var channelData = new float[_state.Channels.Length][];
		for (var ch = 0; ch < channelData.Length; ch++)
		{
			if (_state.Channels[ch].ChannelActive)
			{
				var signal = new float[_state.FFTLength];
				for (int i = 0; i < _state.FFTLength; i++)
					signal[i] = (rand.NextSingle() * 2 - 1) * _state.Channels[ch].RangeInMillivolts / 1000f;

				var fft = new float[_state.FFTLength + 2];
				Array.Copy(signal, fft, _state.FFTLength);
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

				switch (_state.TimeMode)
				{
					case "time":
						channelData[ch] = signal;
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
		switch (_state.TimeMode)
		{
			case "time":
				SendStreamData(new { XMin = 0, XMax = _dt * (_state.FFTLength - 1), Data = channelData, Mode = "time", Length = _state.FFTLength });
				break;
			case "fft":
				SendStreamData(new { XMin = 0, XMax = 1 / (2 * _dt), Data = channelData, Mode = "fft", Length = _state.FFTLength / 2 + 1 });
				break;
		}
	}
}
