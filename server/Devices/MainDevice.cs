using System.Text.Json;
using System.Text.RegularExpressions;

public class MainState
{
	public string SaveDirectory { get; set; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Experiment");
	public string Filename { get; set; } = "";
	public int PendingActions { get; set; } = 0;
	public bool IsRecording { get; set; } = false;
	public int RecordingTimeSeconds { get; set; } = 0;
	public int PlannedRecordingTimeSeconds { get; set; } = 0;
	public int RemainingAdditionalRecordings { get; set; } = 0;
}

public class MainDevice : DeviceHandlerBase<MainState>
{
	public CancellationTokenSource RunningCts = new CancellationTokenSource();
	public MainDevice()
	{
		Task.Run(async () =>
		{
			while (!RunningCts.IsCancellationRequested)
			{
				await Task.Delay(5000, RunningCts.Token);
				ThreadPool.GetMaxThreads(out int workerThreads, out int completionPortThreads);
				ThreadPool.GetAvailableThreads(out int availableWorkerThreads, out int availableCompletionPortThreads);
				Console.WriteLine($"Available worker threads: {availableWorkerThreads}/{workerThreads}, completion port threads: {availableCompletionPortThreads}/{completionPortThreads}");
			}
		});
	}

	public override void Dispose()
	{
		RunningCts.Cancel();
	}

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
		var getState = (string statePath) =>
		{
			try
			{
				var path = statePath.Split('.');
				if (path.Length != 2)
					return statePath;
				var state = DeviceManager!.Devices[path[0]].GetState();
				if (state is IDictionary<string, object> dict && dict.TryGetValue(path[1], out var value))
					return value.ToString() ?? statePath;
				return statePath;
			}
			catch
			{
				Console.WriteLine($"Failed to get state for {statePath}");
				return statePath;
			}
		};
		var interpolatePath = (string path) =>
		{
			var date = DateTime.Now - TimeSpan.FromHours(4); // in case it's after midnight
			return Regex.Replace(path, @"\{([\w\.]+)\}", match =>
			{
				return match.Groups[1].Value switch
				{
					"year" => date.ToString("yyyy"),
					"month" => date.ToString("MM"),
					"day" => date.ToString("dd"),
					"date" => date.ToString("yyyy-MM-dd"),
					"time" => date.ToString("HH:mm:ss"),
					string s => getState(s),
				};
			});
		};
		var path = interpolatePath(State.SaveDirectory);
		if (!Directory.Exists(path))
		{
			Directory.CreateDirectory(path);
		}
		var currentIndex = Directory.GetFiles(path).Select(f =>
		{
			var captures = Regex.Match(Path.GetFileName(f), @"^(\d+)[\s\.]").Groups;
			return captures.Count > 1 ? int.Parse(captures[1].Value) : 0;
		}).Prepend(0).Max();
		return Path.Combine(path, $"{currentIndex + 1}{(State.Filename != "" ? $" {interpolatePath(State.Filename)}" : "")}");
	}

	public void SetRemainingAdditionalRecordings(int count)
	{
		State.RemainingAdditionalRecordings = count;
		SendStateUpdate(new { State.RemainingAdditionalRecordings });
	}

	public void SaveSnapshot()
	{
		var filepath = GetSaveFilepath();
		DeviceManager!.SaveSnapshot(filepath);
	}

	private CancellationTokenSource? RecordingCancellationTokenSource;
	public void StartRecording(int maxDurationSeconds = 0)
	{
		if (RecordingCancellationTokenSource != null) return;
		var filepath = GetSaveFilepath();
		RecordingCancellationTokenSource = new();
		var token = RecordingCancellationTokenSource.Token;
		DeviceManager!.Record(filepath, token);
		State.IsRecording = true;
		State.PlannedRecordingTimeSeconds = maxDurationSeconds;
		SendStateUpdate(new { State.IsRecording, State.PlannedRecordingTimeSeconds });
		var startTime = DateTime.Now;
		Task.Run(async () =>
		{
			while (!token.IsCancellationRequested)
			{
				var seconds = (int)(DateTime.Now - startTime).TotalSeconds;
				if (State.RecordingTimeSeconds != seconds)
				{
					State.RecordingTimeSeconds = seconds;
					SendStateUpdate(new { State.RecordingTimeSeconds });
				}
				if (maxDurationSeconds > 0 && seconds >= maxDurationSeconds)
				{
					StopRecording();
				}
				await Task.Delay(100);
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

	public void AbortRecording()
	{
		DeviceManager!.DiscardRecording = true;
		StopRecording();
	}

	public override object? OnSaveSnapshot(Func<string, Stream>? getStream, string deviceId) => null;

	internal string? Passphrase = null;

	override public object? GetSettings()
	{
		return new
		{
			State.SaveDirectory,
			State.Filename,
			Passphrase,
		};
	}

	public override void LoadSettings(JsonElement settings)
	{
		if (settings.TryGetProperty("SaveDirectory", out var saveDirectory))
		{
			State.SaveDirectory = saveDirectory.GetString()!;
		}
		if (settings.TryGetProperty("LastFilename", out var lastFilename))
		{
			State.Filename = lastFilename.GetString()!;
		}
		if (settings.TryGetProperty("Passphrase", out var passphrase))
		{
			Passphrase = passphrase.GetString();
		}

		if (string.IsNullOrEmpty(Passphrase))
		{
			Passphrase = RandomUtils.GetRandomHash();
		}
		Console.WriteLine($"\nAccess Token: {Passphrase}\n");
	}
}
