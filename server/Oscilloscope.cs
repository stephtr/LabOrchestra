public class OscilloscopeChannel
{
	public bool ChannelActive { get; set; } = true;
	public int RangeInMillivolts { get; set; } = 1000;
}

public class OscilloscopeState
{
	public bool Running { get; set; } = true;
	public string Mode { get; set; } = "time"; // Default mode is "time"

	public OscilloscopeChannel[] Channels { get; set; } =
	{
		new OscilloscopeChannel(),
		new OscilloscopeChannel(),
		new OscilloscopeChannel(),
		new OscilloscopeChannel(),
	};
}

public class OscilloscopeHandler : DeviceHandlerBase<OscilloscopeState>
{
	public OscilloscopeHandler()
	{
		new Timer(DoWork, null, TimeSpan.Zero, TimeSpan.FromSeconds(0.1));
	}

	public void Start()
	{
		_state.Running = true;
	}
	public void Stop()
	{
		_state.Running = false;
	}

	public void ChannelActive(int channel, bool active)
	{
		_state.Channels[channel].ChannelActive = active;
	}

	public void UpdateRange(int channel, int rangeInMillivolts)
	{
		_state.Channels[channel].RangeInMillivolts = rangeInMillivolts;
	}

	private void DoWork(object? _)
	{
		if (!_state.Running) return;
		var rand = new Random();
		var channelData = new float[_state.Channels.Length][];
		var dataLength = 500;
		for (var ch = 0; ch < channelData.Length; ch++)
		{
			if (_state.Channels[ch].ChannelActive)
			{
				channelData[ch] = new float[dataLength];
				for (int i = 0; i < dataLength; i++)
					channelData[ch][i] = (rand.NextSingle() * 2 - 1) * _state.Channels[ch].RangeInMillivolts / 1000f;
			}
			else
			{
				channelData[ch] = Array.Empty<float>();
			}
		}
		SendStreamData(channelData);
	}
}
