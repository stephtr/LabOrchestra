public class OscilloscopeState
{
    public bool Running { get; set; } = true;
    public string Mode { get; set; } = "time"; // Default mode is "time"
}

public class OscilloscopeHandler : DeviceHandlerBase<OscilloscopeState>
{
    private Timer? _timer;
    public OscilloscopeHandler()
    {
        _timer = new Timer(DoWork, null, TimeSpan.Zero, TimeSpan.FromSeconds(0.1));
    }

    public void Start()
    {
        _state.Running = true;
        SendStateUpdate(new { _state.Running });
    }
    public void Stop()
    {
        _state.Running = false;
        SendStateUpdate(new { _state.Running });
    }

    private void DoWork(object? _)
    {
        if (!_state.Running) return;
        var rand = new Random();
        var data = new float[500];
        for (int i = 0; i < data.Length; i++)
            data[i] = rand.NextSingle();
        SendStreamData(data);
    }
}