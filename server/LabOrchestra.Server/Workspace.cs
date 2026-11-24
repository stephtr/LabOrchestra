using System.Text.Json;
using System.Text.RegularExpressions;

namespace LabOrchestra.Server;

/// <summary>One entry of devices.json. <c>File</c> is relative to the workspace folder.</summary>
public sealed record DeviceConfig(string File, string? Python = null, Dictionary<string, JsonElement>? Config = null, string? Description = null);

public sealed record DevicesFile(Dictionary<string, DeviceConfig>? Devices);

/// <summary>The folder with devices.json and the user's own devices, procedures and views. devices.json is watched:
/// when it changes and is valid, <see cref="Changed"/> fires; a broken file is reported and the old setup stays.</summary>
public sealed partial class Workspace : IDisposable
{
	private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { ReadCommentHandling = JsonCommentHandling.Skip };

	private static readonly JsonSerializerOptions WriteOptions = new(JsonSerializerDefaults.Web)
	{
		WriteIndented = true,
		IndentCharacter = '\t',
		IndentSize = 1,
		DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
	};

	private readonly object _editGate = new();
	private FileSystemWatcher? _watcher;
	private Timer? _debounce;
	private ILogger? _log;

	public string Path { get; }
	public IReadOnlyDictionary<string, DeviceConfig> Devices { get; private set; }
	public event Action? Changed;
	public bool HasDevicesFile => File.Exists(System.IO.Path.Combine(Path, "devices.json"));

	private Workspace(string path, Dictionary<string, DeviceConfig> devices)
	{
		Path = path;
		Devices = devices;
	}

	[GeneratedRegex("^[a-z][a-z0-9]*(_[a-z0-9]+)*$")]
	private static partial Regex SnakeCase();

	public static Workspace Load(string path) => new(path, Parse(path));

	private static Dictionary<string, DeviceConfig> Parse(string path)
	{
		var file = System.IO.Path.Combine(path, "devices.json");
		var devices = new Dictionary<string, DeviceConfig>();
		if (!File.Exists(file)) return devices;
		DevicesFile? parsed;
		try
		{
			parsed = JsonSerializer.Deserialize<DevicesFile>(File.ReadAllText(file), JsonOptions);
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
		return devices;
	}

	/// <summary>Changes the device list and writes devices.json (the change is applied at once, the file watcher then finds nothing new).</summary>
	public void Update(Action<Dictionary<string, DeviceConfig>> change)
	{
		lock (_editGate)
		{
			var next = new Dictionary<string, DeviceConfig>(Devices);
			change(next);
			var file = System.IO.Path.Combine(Path, "devices.json");
			Directory.CreateDirectory(Path);
			var temporary = file + ".tmp";
			File.WriteAllText(temporary, JsonSerializer.Serialize(new DevicesFile(next), WriteOptions) + "\n");
			File.Move(temporary, file, overwrite: true); // like an editor: write elsewhere, then rename
			Devices = next;
		}
	}

	public void Watch(ILogger log)
	{
		_log = log;
		Directory.CreateDirectory(Path);
		_watcher = new FileSystemWatcher(Path, "devices.json")
		{
			NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size | NotifyFilters.CreationTime,
			EnableRaisingEvents = true,
		};
		FileSystemEventHandler onChange = (_, _) => _debounce = new Timer(_ => Reload(), null, 300, Timeout.Infinite);
		_watcher.Changed += onChange;
		_watcher.Created += onChange;
		_watcher.Deleted += onChange;
		_watcher.Renamed += (s, e) => onChange(s, e); // editors save by writing a temporary file and renaming it
	}

	private void Reload()
	{
		try
		{
			var next = Parse(Path);
			if (JsonSerializer.Serialize(next) == JsonSerializer.Serialize(Devices)) return;
			Devices = next;
			_log?.LogInformation("devices.json changed: {Count} device(s)", next.Count);
			Changed?.Invoke();
		}
		catch (Exception e) when (e is InvalidOperationException or IOException)
		{
			_log?.LogError("devices.json was not loaded, the running devices stay as they are: {Message}", e.Message);
		}
	}

	public void Dispose()
	{
		_watcher?.Dispose();
		_debounce?.Dispose();
	}
}
