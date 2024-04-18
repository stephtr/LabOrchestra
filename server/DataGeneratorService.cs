public class DataGeneratorService: IHostedService
{
    private Timer? _timer;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _timer = new Timer(DoWork, null, TimeSpan.Zero, TimeSpan.FromSeconds(0.01));
        return Task.CompletedTask;
    }

    public void StopTimer()
    {
        _timer?.Change(Timeout.Infinite, 0);
    }

    private async void DoWork(object? state)
    {
        var rand = new Random();
        var data = new float[500];
        for (int i = 0; i < data.Length; i++)
            data[i] = rand.NextSingle();
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _timer?.Change(Timeout.Infinite, 0);
        return Task.CompletedTask;
    }
}
