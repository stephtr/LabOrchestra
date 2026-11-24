public class OscilloscopeChannel
{
	public bool ChannelActive { get; set; } = false;
	public int RangeInMillivolts { get; set; } = 1000;
	public string Coupling { get; set; } = "AC";
}

public class OscilloscopeState
{
	public bool Running { get; set; } = true;
	public string DisplayMode { get; set; } = "fft";
	public float FFTFrequency { get; set; } = 10e6f;
	public int FFTLength { get; set; } = 8192;
	public string FFTAveragingMode { get; set; } = "prefer-data";
	public int FFTAveragingDurationInMilliseconds { get; set; } = 200;
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
