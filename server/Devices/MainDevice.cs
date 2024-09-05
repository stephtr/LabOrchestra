using System.Text.Json;
using System.Text.RegularExpressions;

public class MainState
{
	public string SaveDirectory { get; set; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Experiment");
	public string Filename { get; set; } = "";
	public int PendingActions { get; set; } = 0;
	public bool IsRecording { get; set; } = false;
	public int RecordingTimeSeconds { get; set; } = 0;
}

public class MainDevice : DeviceHandlerBase<MainState>
{
	public void AddPendingAction()
	{
		State.PendingActions++;
		SendStateUpdate(new { State.PendingActions });
	}
	public void FinishPendingAction()
	{
		State.PendingActions--;
		SendStateUpdate(new { State.PendingActions });
	}

	public void SetSaveDirectory(string directory)
	{
		State.SaveDirectory = directory;
	}

	public void SetFilename(string filename)
	{
		State.Filename = filename;
	}

	private string GetSaveFilepath()
	{
		var date = DateTime.Now - TimeSpan.FromHours(4); // in case it's after midnight
		var path = State.SaveDirectory.Replace("{year}", date.ToString("yyyy")).Replace("{date}", date.ToString("yyyy-MM-dd"));
		if (!Directory.Exists(path))
		{
			Directory.CreateDirectory(path);
		}
		var currentIndex = Directory.GetFiles(path).Select(f =>
		{
			var captures = Regex.Match(Path.GetFileName(f), @"^(\d+)[\s\.]").Groups;
			return captures.Count > 1 ? int.Parse(captures[1].Value) : 0;
		}).Prepend(0).Max();
		return Path.Combine(path, $"{currentIndex + 1}{(State.Filename != "" ? $" {State.Filename}" : "")}");
	}

	public void SaveSnapshot()
	{
		var filepath = GetSaveFilepath();
		DeviceManager!.SaveSnapshot(filepath);
	}

	private CancellationTokenSource? RecordingCancellationTokenSource;
	public void StartRecording()
	{
		if (RecordingCancellationTokenSource != null) return;
		SendStateUpdate(new { State.IsRecording });
		var filepath = GetSaveFilepath();
		RecordingCancellationTokenSource = new();
		DeviceManager!.Record(filepath, RecordingCancellationTokenSource.Token);
		State.IsRecording = true;
		var startTime = DateTime.Now;
		Task.Run(() =>
		{
			while (!RecordingCancellationTokenSource.IsCancellationRequested)
			{
				var seconds = (int)(DateTime.Now - startTime).TotalSeconds;
				if (State.RecordingTimeSeconds != seconds)
				{
					State.RecordingTimeSeconds = seconds;
					SendStateUpdate(new { State.RecordingTimeSeconds });
				}
				Thread.Sleep(100);
			}
		});
	}

	public void StopRecording()
	{
		RecordingCancellationTokenSource?.Cancel();
		RecordingCancellationTokenSource = null;
		State.IsRecording = false;
		SendStateUpdate(new { State.IsRecording });
	}

	public override object? OnSaveSnapshot(Func<string, Stream>? getStream, string deviceId) => null;

	override public object? GetSettings()
	{
		return new
		{
			State.SaveDirectory,
			State.Filename,
		};
	}

	public override void LoadSettings(JsonElement settings)
	{
		State.SaveDirectory = settings.GetProperty("SaveDirectory").GetString()!;
		State.Filename = settings.GetProperty("LastFilename").GetString()!;
	}
}
