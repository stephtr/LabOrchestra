using System.Text.Json;
using System.Text.RegularExpressions;

public class MainState
{
	public string SaveDirectory { get; set; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Experiment");
	public string LastFilename { get; set; } = "";
}

public class MainDevice : DeviceHandlerBase<MainState>
{
	public void SetSaveDirectory(string directory)
	{
		_state.SaveDirectory = directory;
	}

	public void SetLastFilename(string filename)
	{
		_state.LastFilename = filename;
	}

	public void Save()
	{
		var date = DateTime.Now - TimeSpan.FromHours(4); // in case it's after midnight
		var path = _state.SaveDirectory.Replace("{year}", date.ToString("yyyy")).Replace("{date}", date.ToString("yyyy-MM-dd"));
		if (!Directory.Exists(path))
		{
			Directory.CreateDirectory(path);
		}
		var currentIndex = Directory.GetFiles(path).Select(f =>
		{
			var captures = Regex.Match(Path.GetFileName(f), @"^(\d+)\s").Captures;
			return captures.Count > 0 ? int.Parse(captures[0].Value) : 0;
		}).Prepend(0).Max();
		var baseFilepath = Path.Combine(path, $"{currentIndex + 1} {_state.LastFilename}");

		_deviceManager!.Save(baseFilepath);
	}

	override public object? GetSettings()
	{
		return new
		{
			_state.SaveDirectory,
			_state.LastFilename,
		};
	}

	public override void LoadSettings(JsonElement settings)
	{
		_state.SaveDirectory = settings.GetProperty("SaveDirectory").GetString()!;
		_state.LastFilename = settings.GetProperty("LastFilename").GetString()!;
	}
}
