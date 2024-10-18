using System.Text.Json;

public class PressureUploader : IAddon
{
	private string DeviceName;
	private int SelectedChannel;
	private string UploadUrl;
	private string ApiKey;
	private TimeSpan TimeInterval;

	public PressureUploader(string deviceName, int selectedChannel, string uploadUrl, string apiKey, TimeSpan timeInterval)
	{
		DeviceName = deviceName;
		SelectedChannel = selectedChannel;
		UploadUrl = uploadUrl;
		ApiKey = apiKey;
		TimeInterval = timeInterval;
	}
	public void DoWork(DeviceManager deviceManager, CancellationToken cancellationToken)
	{
		List<float> PressureReadings = new();
		var start = DateTime.UtcNow;
		var client = new HttpClient();
		while (!cancellationToken.IsCancellationRequested)
		{
			try
			{
				dynamic? pressureState = deviceManager.Devices[DeviceName]?.GetState();
				if (pressureState == null) continue;
				var pressure = pressureState.channels[SelectedChannel];
				PressureReadings.Add(pressure);
				if (DateTime.UtcNow - start > TimeInterval)
				{
					start = DateTime.UtcNow;
					if (PressureReadings.Count == 0) continue;

					var content = new StringContent(JsonSerializer.Serialize(new
					{
						pressure = PressureReadings.Average(),
						channel = SelectedChannel,
					}));
					content.Headers.Add("Authorization", $"Bearer {ApiKey}");
					client.PostAsync(UploadUrl, content);
					PressureReadings.Clear();
				}
			}
			catch { }
			cancellationToken.WaitHandle.WaitOne(1000);
		}
	}
}
