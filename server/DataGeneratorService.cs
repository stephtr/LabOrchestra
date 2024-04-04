using ExperimentControl.Hubs;
using Microsoft.AspNetCore.SignalR;

public class DataGeneratorService: IHostedService
{
    private readonly IHubContext<OscilloscopeHub> _hubContext;
    private Timer? _timer;

    public DataGeneratorService(IHubContext<OscilloscopeHub> hubContext)
    {
        _hubContext = hubContext;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _timer = new Timer(DoWork, null, TimeSpan.Zero, TimeSpan.FromSeconds(0.01));
        return Task.CompletedTask;
    }

    private async void DoWork(object? state)
    {
        var rand = new Random();
        var data = new float[5000];
        for (int i = 0; i < data.Length; i++)
            data[i] = rand.NextSingle();
        await _hubContext.Clients.All.SendAsync("ReceiveData", data);
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _timer?.Change(Timeout.Infinite, 0);
        return Task.CompletedTask;
    }
}
