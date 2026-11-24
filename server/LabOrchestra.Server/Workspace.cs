using System.Text.Json;
using System.Text.RegularExpressions;

namespace LabOrchestra.Server;

/// <summary>One entry of devices.json. <c>File</c> is relative to the workspace folder.</summary>
public sealed record DeviceConfig(string File, string? Python = null, Dictionary<string, JsonElement>? Config = null);

public sealed record DevicesFile(Dictionary<string, DeviceConfig>? Devices);

/// <summary>The folder with devices.json and the user's own devices, procedures and views.</summary>
public sealed partial class Workspace
{
	public string Path { get; }
	public IReadOnlyDictionary<string, DeviceConfig> Devices { get; }

	private Workspace(string path, Dictionary<string, DeviceConfig> devices)
	{
		Path = path;
		Devices = devices;
	}

	[GeneratedRegex("^[a-z][a-z0-9]*(_[a-z0-9]+)*$")]
	private static partial Regex SnakeCase();

	public static Workspace Load(string path)
	{
		var file = System.IO.Path.Combine(path, "devices.json");
		var devices = new Dictionary<string, DeviceConfig>();
		if (File.Exists(file))
		{
			DevicesFile? parsed;
			try
			{
				parsed = JsonSerializer.Deserialize<DevicesFile>(File.ReadAllText(file), new JsonSerializerOptions(JsonSerializerDefaults.Web) { ReadCommentHandling = JsonCommentHandling.Skip });
			}
			catch (JsonException e)
			{
				throw new InvalidOperationException($"{file} is not valid: {e.Message}");
			}
			foreach (var (id, device) in parsed?.Devices ?? [])
			{
				if (!SnakeCase().IsMatch(id))
					throw new InvalidOperationException($"{file}: device id '{id}' must be snake_case (lowercase letters, digits, underscores)");
				if (string.IsNullOrWhiteSpace(device.File))
					throw new InvalidOperationException($"{file}: device '{id}' needs a \"file\"");
				devices[id] = device;
			}
		}
		return new Workspace(path, devices);
	}
}
