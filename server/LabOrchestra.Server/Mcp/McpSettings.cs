using System.Text.Json;

namespace LabOrchestra.Server.Mcp;

/// <summary>What AI clients may do at most, for all MCP tokens together: "off" (nothing; the default), "read_only" (look at the experiment) or
/// "control" (also act). A token has a mode of its own; the lower of the two applies. Kept in mcp.json of the data folder, changed in the UI.</summary>
public sealed class McpSettings
{
	public static readonly string[] Modes = ["off", "read_only", "control"];
	private readonly string _file;
	private readonly object _lock = new();
	private string _mode = "off";

	public McpSettings(string dataDir)
	{
		_file = Path.Combine(dataDir, "mcp.json");
		try
		{
			if (File.Exists(_file) && JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(_file)).TryGetProperty("mode", out var mode) && mode.GetString() is { } m && Modes.Contains(m)) _mode = m;
		}
		catch (JsonException) { /* unreadable: stays off */ }
	}

	public string Mode { get { lock (_lock) return _mode; } }

	public void Set(string mode)
	{
		if (!Modes.Contains(mode)) throw new ArgumentException($"The mode must be one of {string.Join(", ", Modes)}");
		lock (_lock)
		{
			_mode = mode;
			Directory.CreateDirectory(Path.GetDirectoryName(_file)!);
			File.WriteAllText(_file, JsonSerializer.Serialize(new { mode }));
		}
	}

	/// <summary>The lower of the global mode and the token's.</summary>
	public string Effective(string tokenMode)
	{
		var rank = (string m) => Math.Max(0, Array.IndexOf(Modes, m));
		return Modes[Math.Min(rank(Mode), rank(tokenMode))];
	}
}
