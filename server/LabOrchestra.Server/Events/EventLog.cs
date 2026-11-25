using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace LabOrchestra.Server.Events;

/// <summary>
/// The persistent memory of the server, outside the recordings (SQLite, one file in the data folder): what happened to devices (actions
/// with their caller, status changes), a low-rate history of the numeric fields of every device's state (one value per field per
/// <c>historyInterval</c>, so that a pressure curve of last week exists even when nothing was recording), and notes. Events are queued by the
/// bus listener and written by one thread in batches, so that a slow disk never delays a device.
/// </summary>
public sealed class EventLog : IHostedService, IDisposable
{
	private static readonly TimeSpan KeepEvents = TimeSpan.FromDays(90), KeepHistory = TimeSpan.FromDays(30);

	private readonly string _path;
	private readonly EventBus _bus;
	private readonly TimeSpan _historyInterval;
	private readonly ILogger<EventLog> _log;
	private readonly BlockingCollection<Action<SqliteConnection>> _work = new(boundedCapacity: 100_000);
	private readonly Dictionary<(string, string), DateTimeOffset> _lastSampled = new();
	private Thread? _writer;
	private Action<DeviceEvent>? _listener;

	public EventLog(string dataDir, EventBus bus, double historyIntervalSeconds, ILogger<EventLog> log)
	{
		Directory.CreateDirectory(dataDir);
		(_path, _bus, _historyInterval, _log) = (Path.Combine(dataDir, "events.db"), bus, TimeSpan.FromSeconds(historyIntervalSeconds), log);
		using var db = Open();
		Execute(db, """
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, time REAL NOT NULL, device TEXT NOT NULL, kind TEXT NOT NULL, by TEXT NOT NULL, data TEXT NOT NULL);
			CREATE INDEX IF NOT EXISTS events_time ON events (time);
			CREATE INDEX IF NOT EXISTS events_device ON events (device, time);
			CREATE TABLE IF NOT EXISTS history (time REAL NOT NULL, device TEXT NOT NULL, path TEXT NOT NULL, value REAL NOT NULL);
			CREATE INDEX IF NOT EXISTS history_series ON history (device, path, time);
			CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, time REAL NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, refs TEXT NOT NULL);
			""");
		Prune(db);
	}

	public Task StartAsync(CancellationToken cancel)
	{
		_listener = Enqueue;
		_bus.Published += _listener;
		_writer = new Thread(WriteLoop) { Name = "event-log", IsBackground = true };
		_writer.Start();
		return Task.CompletedTask;
	}

	public Task StopAsync(CancellationToken cancel)
	{
		if (_listener is not null) _bus.Published -= _listener;
		_work.CompleteAdding();
		_writer?.Join(TimeSpan.FromSeconds(5)); // what is queued gets written
		return Task.CompletedTask;
	}

	public void Dispose() => _work.Dispose();

	private SqliteConnection Open()
	{
		var db = new SqliteConnection($"Data Source={_path};Pooling=False");
		db.Open();
		return db;
	}

	// --- writing ---------------------------------------------------------------------------------------------------
	private void Enqueue(DeviceEvent e)
	{
		var time = e.Time.ToUnixTimeMilliseconds() / 1000.0;
		switch (e.Kind)
		{
			case "action" or "status":
				var json = JsonSerializer.Serialize(e.Data);
				Add(db => Run(db, "INSERT INTO events (time, device, kind, by, data) VALUES ($t, $d, $k, $b, $x)", ("$t", time), ("$d", e.Device), ("$k", e.Kind), ("$b", e.By), ("$x", json)));
				break;
			case "patch" when e.Data.TryGetValue("set", out var set) && set is Dictionary<string, object?> values:
				Sample(e, time, values);
				break;
			case "replace" when e.Data.TryGetValue("state", out var state) && state is Dictionary<string, object?> whole:
				Sample(e, time, Flatten(whole));
				break;
		}
	}

	private void Sample(DeviceEvent e, double time, Dictionary<string, object?> values)
	{
		List<(string Path, double Value)>? due = null;
		lock (_lastSampled) // the bus calls from many threads
			foreach (var (path, value) in values)
			{
				if (value is null or bool or string || !IsNumber(value)) continue;
				var number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
				if (double.IsNaN(number) || double.IsInfinity(number)) continue;
				if (_lastSampled.TryGetValue((e.Device, path), out var last) && e.Time - last < _historyInterval) continue;
				_lastSampled[(e.Device, path)] = e.Time;
				(due ??= []).Add((path, number));
			}
		if (due is null) return;
		Add(db =>
		{
			using var transaction = db.BeginTransaction();
			foreach (var (path, value) in due)
				Run(db, "INSERT INTO history (time, device, path, value) VALUES ($t, $d, $p, $v)", ("$t", time), ("$d", e.Device), ("$p", path), ("$v", value));
			transaction.Commit();
		});
	}

	private static bool IsNumber(object v) => v is byte or sbyte or short or ushort or int or uint or long or ulong or float or double or decimal;

	/// <summary>{"a": {"b": [1, 2]}} -> {"a.b.0": 1, "a.b.1": 2}: the same paths as in state patches.</summary>
	private static Dictionary<string, object?> Flatten(Dictionary<string, object?> state)
	{
		var result = new Dictionary<string, object?>();
		void Walk(string prefix, object? value)
		{
			switch (value)
			{
				case Dictionary<string, object?> map: foreach (var (k, v) in map) Walk(prefix.Length == 0 ? k : $"{prefix}.{k}", v); break;
				case System.Collections.IList list: for (var i = 0; i < list.Count; i++) Walk($"{prefix}.{i}", list[i]); break;
				default: result[prefix] = value; break;
			}
		}
		Walk("", state);
		return result;
	}

	private void Add(Action<SqliteConnection> work)
	{
		if (!_work.IsAddingCompleted && !_work.TryAdd(work)) _log.LogWarning("The event log cannot keep up; an entry was dropped");
	}

	private void WriteLoop()
	{
		using var db = Open();
		var lastPrune = DateTime.UtcNow;
		foreach (var work in _work.GetConsumingEnumerable())
		{
			try { work(db); }
			catch (Exception e) when (e is SqliteException or IOException) { _log.LogWarning("Could not write to the event log: {Message}", e.Message); }
			if (DateTime.UtcNow - lastPrune > TimeSpan.FromHours(6)) { Prune(db); lastPrune = DateTime.UtcNow; }
		}
	}

	private static void Prune(SqliteConnection db)
	{
		var now = DateTimeOffset.UtcNow;
		Run(db, "DELETE FROM events WHERE time < $t", ("$t", (now - KeepEvents).ToUnixTimeSeconds()));
		Run(db, "DELETE FROM history WHERE time < $t", ("$t", (now - KeepHistory).ToUnixTimeSeconds()));
	}

	// --- reading ---------------------------------------------------------------------------------------------------
	/// <summary>Waits until everything queued so far is written (for tests and for a reader that wants to see its own events).</summary>
	public void Flush()
	{
		using var done = new ManualResetEventSlim();
		Add(_ => done.Set());
		done.Wait(TimeSpan.FromSeconds(10));
	}

	public List<Dictionary<string, object?>> Events(string? device, string? kind, double since, double until, int limit)
	{
		Flush();
		using var db = Open();
		using var command = db.CreateCommand();
		command.CommandText = "SELECT id, time, device, kind, by, data FROM events WHERE time >= $s AND time <= $u AND ($d IS NULL OR device = $d) AND ($k IS NULL OR kind = $k) ORDER BY id DESC LIMIT $l";
		Bind(command, ("$s", since), ("$u", until <= 0 ? double.MaxValue : until), ("$d", device), ("$k", kind), ("$l", limit));
		var rows = new List<Dictionary<string, object?>>();
		using var reader = command.ExecuteReader();
		while (reader.Read())
			rows.Add(new() { ["id"] = reader.GetInt64(0), ["time"] = reader.GetDouble(1), ["device"] = reader.GetString(2), ["kind"] = reader.GetString(3), ["by"] = reader.GetString(4), ["data"] = Plain.FromJson(JsonDocument.Parse(reader.GetString(5)).RootElement) });
		rows.Reverse(); // oldest first
		return rows;
	}

	/// <summary>The history of one field as [time, value] pairs, at most <paramref name="maxPoints"/>: buckets of equal length, each giving its mean.</summary>
	public List<double[]> History(string device, string path, double since, double until, int maxPoints)
	{
		Flush();
		using var db = Open();
		using var command = db.CreateCommand();
		command.CommandText = "SELECT time, value FROM history WHERE device = $d AND path = $p AND time >= $s AND time <= $u ORDER BY time";
		Bind(command, ("$d", device), ("$p", path), ("$s", since), ("$u", until <= 0 ? double.MaxValue : until));
		var points = new List<double[]>();
		using (var reader = command.ExecuteReader())
			while (reader.Read()) points.Add([reader.GetDouble(0), reader.GetDouble(1)]);
		if (maxPoints <= 0 || points.Count <= maxPoints) return points;
		var size = (double)points.Count / maxPoints;
		return Enumerable.Range(0, maxPoints).Select(i =>
		{
			var bucket = points.Skip((int)(i * size)).Take(Math.Max(1, (int)((i + 1) * size) - (int)(i * size))).ToList();
			return new[] { bucket.Average(p => p[0]), bucket.Average(p => p[1]) };
		}).ToList();
	}

	public string AddNote(string text, IEnumerable<string>? refs, string author)
	{
		if (string.IsNullOrWhiteSpace(text)) throw new ArgumentException("A note needs text");
		var id = Guid.NewGuid().ToString("N");
		var time = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;
		var json = JsonSerializer.Serialize(refs ?? []);
		Add(db => Run(db, "INSERT INTO notes (id, time, author, text, refs) VALUES ($i, $t, $a, $x, $r)", ("$i", id), ("$t", time), ("$a", author), ("$x", text), ("$r", json)));
		return id;
	}

	/// <summary>Notes, newest last; with <paramref name="reference"/> only those that point at it (a device id, a recording id, ...).</summary>
	public List<Dictionary<string, object?>> Notes(string? reference, double since, int limit)
	{
		Flush();
		using var db = Open();
		using var command = db.CreateCommand();
		command.CommandText = "SELECT id, time, author, text, refs FROM notes WHERE time >= $s ORDER BY time DESC";
		Bind(command, ("$s", since));
		var rows = new List<Dictionary<string, object?>>();
		using var reader = command.ExecuteReader();
		while (reader.Read() && rows.Count < limit)
		{
			var refs = JsonSerializer.Deserialize<List<string>>(reader.GetString(4)) ?? [];
			if (reference is not null && !refs.Contains(reference)) continue;
			rows.Add(new() { ["id"] = reader.GetString(0), ["time"] = reader.GetDouble(1), ["author"] = reader.GetString(2), ["text"] = reader.GetString(3), ["refs"] = refs });
		}
		rows.Reverse();
		return rows;
	}

	private static void Execute(SqliteConnection db, string sql)
	{
		using var command = db.CreateCommand();
		command.CommandText = sql;
		command.ExecuteNonQuery();
	}

	private static void Run(SqliteConnection db, string sql, params (string Name, object? Value)[] parameters)
	{
		using var command = db.CreateCommand();
		command.CommandText = sql;
		Bind(command, parameters);
		command.ExecuteNonQuery();
	}

	private static void Bind(SqliteCommand command, params (string Name, object? Value)[] parameters)
	{
		foreach (var (name, value) in parameters) command.Parameters.AddWithValue(name, value ?? DBNull.Value);
	}
}
