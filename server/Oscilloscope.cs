public class OscilloscopeState
{
    public bool Running { get; set; } = true;
    public string Mode { get; set; } = "time"; // Default mode is "time"

    public int RangeInMillivolts { get; set; } = 1000;
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

    public void UpdateRange(int rangeInMillivolts)
    {
        _state.RangeInMillivolts = rangeInMillivolts;
    }

    private void DoWork(object? _)
    {
        if (!_state.Running) return;
        var rand = new Random();
        var data = new float[500];
        for (int i = 0; i < data.Length; i++)
            data[i] = (rand.NextSingle() * 2 - 1) * _state.RangeInMillivolts / 1000f;
        SendStreamData(data);
    }
}