using System.Text.Json;

namespace LabOrchestra.Server.Devices;

/// <summary>Values a device asked to keep (its "persist" list), one JSON file per device in the data directory.</summary>
public sealed class SettingsStore(string directory)
{
	public string? Load(string deviceId)
	{
		var file = FileOf(deviceId);
		return File.Exists(file) ? File.ReadAllText(file) : null;
	}

	public void Save(string deviceId, Dictionary<string, object?> values)
	{
		Directory.CreateDirectory(directory);
		var file = FileOf(deviceId);
		var temporary = file + ".tmp";
		File.WriteAllText(temporary, JsonSerializer.Serialize(values, new JsonSerializerOptions { WriteIndented = true }));
		File.Move(temporary, file, overwrite: true); // a crash never leaves half a file
	}

	private string FileOf(string deviceId) => Path.Combine(directory, deviceId + ".json");
}
