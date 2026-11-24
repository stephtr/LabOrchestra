using System.Text.Json;

namespace LabOrchestra.Server.Devices;

/// <summary>Named secrets (API keys, tokens) in the data directory, outside the workspace and outside git. devices.json
/// refers to them as {"secret": "name"}; their values are never sent to clients or logged.</summary>
public sealed class SecretStore(string file)
{
	private readonly object _lock = new();
	private Dictionary<string, string>? _values;

	private Dictionary<string, string> Values =>
		_values ??= File.Exists(file) ? JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(file)) ?? [] : [];

	public string? Get(string name) { lock (_lock) return Values.TryGetValue(name, out var v) ? v : null; }

	public List<string> Names() { lock (_lock) return Values.Keys.Order().ToList(); }

	public void Set(string name, string value) { lock (_lock) { Values[name] = value; Save(); } }

	public bool Delete(string name) { lock (_lock) { var removed = Values.Remove(name); if (removed) Save(); return removed; } }

	private void Save()
	{
		Directory.CreateDirectory(System.IO.Path.GetDirectoryName(file)!);
		var temporary = file + ".tmp";
		File.WriteAllText(temporary, JsonSerializer.Serialize(Values));
		if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
		File.Move(temporary, file, overwrite: true);
	}
}
