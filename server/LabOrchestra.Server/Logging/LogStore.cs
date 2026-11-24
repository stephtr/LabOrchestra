using System.Text.Json;

namespace LabOrchestra.Server.Logging;

/// <summary>
/// Structured log of the server and all devices: a ring buffer per source (for the UI, scripts and the AI) and
/// daily files in the data directory. Entries are dictionaries with snake_case keys so that they go over the wire as they are.
/// </summary>
public sealed class LogStore
{
	public static readonly string[] Levels = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];
	private const int PerSource = 2000;
	private static readonly TimeSpan KeepFiles = TimeSpan.FromDays(30);

	private readonly object _lock = new();
	private readonly Dictionary<string, Queue<Dictionary<string, object?>>> _bySource = new();
	private readonly string? _dir;
	private long _seq;
	private StreamWriter? _file;
	private DateOnly _fileDay;

	public event Action<Dictionary<string, object?>>? Added;

	public LogStore(string? logDirectory)
	{
		_dir = logDirectory;
		if (_dir is null) return;
		Directory.CreateDirectory(_dir);
		foreach (var old in Directory.GetFiles(_dir, "*.jsonl").Where(f => DateTime.UtcNow - File.GetLastWriteTimeUtc(f) > KeepFiles))
			try { File.Delete(old); } catch (IOException) { }
	}

	public static int Rank(string? level) => Math.Max(0, Array.IndexOf(Levels, (level ?? "").ToUpperInvariant()));

	public Dictionary<string, object?> Add(string source, string? level, string logger, string message, string? traceback = null, DateTimeOffset? time = null)
	{
		var known = Array.IndexOf(Levels, (level ?? "").ToUpperInvariant());
		var normalized = Levels[known < 0 ? 1 : known];
		Dictionary<string, object?> entry;
		lock (_lock)
		{
			entry = new Dictionary<string, object?>
			{
				["seq"] = ++_seq,
				["time"] = (time ?? DateTimeOffset.UtcNow).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"),
				["level"] = normalized,
				["source"] = source,
				["logger"] = logger,
				["message"] = message,
				["traceback"] = traceback,
			};
			if (!_bySource.TryGetValue(source, out var queue)) _bySource[source] = queue = new();
			queue.Enqueue(entry);
			while (queue.Count > PerSource) queue.Dequeue();
			WriteToFile(entry);
		}
		Added?.Invoke(entry);
		return entry;
	}

	private void WriteToFile(Dictionary<string, object?> entry)
	{
		if (_dir is null) return;
		try
		{
			var today = DateOnly.FromDateTime(DateTime.UtcNow);
			if (_file is null || _fileDay != today)
			{
				_file?.Dispose();
				_file = new StreamWriter(new FileStream(Path.Combine(_dir, $"{today:yyyy-MM-dd}.jsonl"), FileMode.Append, FileAccess.Write, FileShare.ReadWrite)) { AutoFlush = true };
				_fileDay = today;
			}
			_file.WriteLine(JsonSerializer.Serialize(entry));
		}
		catch (IOException) { /* logging must never break the server */ }
	}

	/// <summary>With since = 0 the latest entries, otherwise the entries after that sequence number (to follow a log).</summary>
	public List<Dictionary<string, object?>> Get(string? source, string? minLevel, long since, int limit)
	{
		var min = Rank(minLevel);
		lock (_lock)
		{
			var entries = (source is null ? _bySource.Values.SelectMany(q => q) : _bySource.TryGetValue(source, out var q) ? q : [])
				.Where(e => (long)e["seq"]! > since && Rank((string?)e["level"]) >= min)
				.OrderBy(e => (long)e["seq"]!);
			return (since == 0 ? entries.TakeLast(limit) : entries.Take(limit)).ToList();
		}
	}
}

/// <summary>Writes what the server logs (our own categories from Information, everything else from Warning) into the store.</summary>
public sealed class LogStoreProvider(LogStore store) : ILoggerProvider
{
	public ILogger CreateLogger(string categoryName) => new StoreLogger(store, categoryName);
	public void Dispose() { }

	private sealed class StoreLogger(LogStore store, string category) : ILogger
	{
		public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
		public bool IsEnabled(LogLevel level) => level >= (category.StartsWith("LabOrchestra") ? LogLevel.Information : LogLevel.Warning);

		public void Log<TState>(LogLevel level, EventId id, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
		{
			if (!IsEnabled(level)) return;
			var name = level switch
			{
				LogLevel.Trace or LogLevel.Debug => "DEBUG",
				LogLevel.Information => "INFO",
				LogLevel.Warning => "WARNING",
				LogLevel.Error => "ERROR",
				_ => "CRITICAL",
			};
			store.Add("server", name, category, formatter(state, exception), exception?.ToString());
		}
	}
}
