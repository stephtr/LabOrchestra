using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace LabOrchestra.Server;

/// <summary>The views of the dashboard: one file <c>views/&lt;id&gt;.json</c> per view in the workspace. Views are global (shared by all clients).
/// The server checks the id, the format version and the size, and keeps the rest as the client wrote it: the layout belongs to the client,
/// so a new kind of widget needs no server change. The folder is watched, so a manual edit or a <c>git pull</c> reaches every client.</summary>
public sealed partial class ViewStore : IDisposable
{
	public const int CurrentVersion = 1;
	private const int MaxBytes = 1024 * 1024;

	private static readonly JsonSerializerOptions WriteOptions = new() { WriteIndented = true, IndentCharacter = '\t', IndentSize = 1 };

	private readonly object _gate = new();
	private readonly string _folder;
	private readonly ILogger _log;
	private Dictionary<string, JsonNode> _views = [];
	private FileSystemWatcher? _watcher;
	private Timer? _debounce;

	public ViewStore(string workspacePath, ILogger<ViewStore> log)
	{
		_folder = Path.Combine(workspacePath, "views");
		_log = log;
		_views = Read();
	}

	/// <summary>Fires with the whole set after any change (views are small).</summary>
	public event Action<IReadOnlyDictionary<string, JsonNode>>? Changed;

	[GeneratedRegex("^[a-z][a-z0-9]*(_[a-z0-9]+)*$")]
	private static partial Regex SnakeCase();

	/// <summary>The views as JSON text, the form in which they go to clients.</summary>
	public static Dictionary<string, string> AsText(IReadOnlyDictionary<string, JsonNode> views) => views.ToDictionary(v => v.Key, v => v.Value.ToJsonString());

	public IReadOnlyDictionary<string, JsonNode> All()
	{
		lock (_gate) return new Dictionary<string, JsonNode>(_views);
	}

	private Dictionary<string, JsonNode> Read()
	{
		var views = new Dictionary<string, JsonNode>();
		if (!Directory.Exists(_folder)) return views;
		foreach (var file in Directory.EnumerateFiles(_folder, "*.json").Order())
		{
			var id = Path.GetFileNameWithoutExtension(file);
			try
			{
				if (!SnakeCase().IsMatch(id)) throw new InvalidOperationException("the file name must be a snake_case id");
				var node = JsonNode.Parse(File.ReadAllText(file), documentOptions: new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip })
					?? throw new InvalidOperationException("the file is empty");
				Check(node);
				views[id] = node;
			}
			catch (Exception e) when (e is InvalidOperationException or JsonException or IOException)
			{
				_log.LogError("views/{File} was not loaded: {Message}", Path.GetFileName(file), e.Message);
			}
		}
		return views;
	}

	private static void Check(JsonNode node)
	{
		if (node is not JsonObject obj) throw new InvalidOperationException("a view is a JSON object");
		var version = obj["version"]?.GetValue<int>() ?? 1;
		if (version > CurrentVersion)
			throw new InvalidOperationException($"the view has the format version {version}, but this LabOrchestra understands up to {CurrentVersion}: update LabOrchestra");
	}

	/// <summary>Writes a view (a new one or a replacement), atomically.</summary>
	public void Save(string id, JsonNode view)
	{
		if (!SnakeCase().IsMatch(id)) throw new ArgumentException($"view id '{id}' must be snake_case (lowercase letters, digits, underscores)");
		Check(view);
		var text = view.ToJsonString(WriteOptions) + "\n";
		if (text.Length > MaxBytes) throw new ArgumentException("the view is too large");
		lock (_gate)
		{
			Directory.CreateDirectory(_folder);
			var file = Path.Combine(_folder, id + ".json");
			var temporary = file + ".tmp";
			File.WriteAllText(temporary, text);
			File.Move(temporary, file, overwrite: true);
			_views = new Dictionary<string, JsonNode>(_views) { [id] = JsonNode.Parse(text)! };
			Changed?.Invoke(All()); // under the lock: calls run in parallel, and the last announcement must be the newest state
		}
	}

	public void Delete(string id)
	{
		lock (_gate)
		{
			if (!_views.ContainsKey(id)) throw new ArgumentException($"there is no view '{id}'");
			File.Delete(Path.Combine(_folder, id + ".json"));
			var next = new Dictionary<string, JsonNode>(_views);
			next.Remove(id);
			_views = next;
			Changed?.Invoke(All());
		}
	}

	public void Watch()
	{
		Directory.CreateDirectory(_folder);
		_watcher = new FileSystemWatcher(_folder, "*.json")
		{
			NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size | NotifyFilters.CreationTime,
			EnableRaisingEvents = true,
		};
		FileSystemEventHandler onChange = (_, _) => _debounce = new Timer(_ => Reload(), null, 300, Timeout.Infinite);
		_watcher.Changed += onChange;
		_watcher.Created += onChange;
		_watcher.Deleted += onChange;
		_watcher.Renamed += (s, e) => onChange(s, e);
	}

	private void Reload()
	{
		Dictionary<string, JsonNode> next;
		lock (_gate)
		{
			next = Read();
			if (JsonSerializer.Serialize(next) == JsonSerializer.Serialize(_views)) return; // our own write
			_views = next;
			_log.LogInformation("views changed: {Count} view(s)", next.Count);
			Changed?.Invoke(All());
		}
	}

	public void Dispose()
	{
		_watcher?.Dispose();
		_debounce?.Dispose();
	}
}
