using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Data.Sqlite;
using LabOrchestra.Server.Auth;
using LabOrchestra.Server.Devices;
using LabOrchestra.Server.Hubs;
using LabOrchestra.Server.Logging;
using LabOrchestra.Server.Recording;
using LabOrchestra.Server.Supervision;

namespace LabOrchestra.Server.Procedures;

/// <summary>One run of a procedure: what was asked, what is happening, how it ended. Kept in memory while it runs and in <c>runs.db</c> after.</summary>
public sealed class Run
{
	public required string Id { get; init; }
	public required string Procedure { get; init; }
	public required string File { get; init; }
	public required string SourceHash { get; init; }
	public required Dictionary<string, object?> Params { get; init; }
	public required string[] Devices { get; init; }
	public required string Caller { get; init; }
	public DateTimeOffset Started { get; init; } = DateTimeOffset.UtcNow;
	public DateTimeOffset? Ended { get; set; }
	/// <summary>preparing, starting, running, paused, aborting, then finished, failed, aborted or crashed (the process died without saying how it ended).</summary>
	public string Status { get; set; } = "preparing";
	public Dictionary<string, object?>? Progress { get; set; }
	public string? Message { get; set; }
	public Dictionary<string, object?>? Error { get; set; }
	public object? Result { get; set; }
	public string? Reason { get; set; }

	internal Process? Process { get; set; }
	internal string? ConnectionId { get; set; }
	internal bool AbortRequested { get; set; }
	internal string? PendingCommand { get; set; }
	internal bool FinalReceived { get; set; }
	internal CancellationTokenSource Cancel { get; } = new();
	internal Queue<string> Tail { get; } = new();

	public bool IsActive => Ended is null;

	public Dictionary<string, object?> Snapshot() => new()
	{
		["id"] = Id, ["procedure"] = Procedure, ["file"] = File, ["source_hash"] = SourceHash, ["params"] = Params, ["devices"] = Devices.Cast<object?>().ToList(),
		["caller"] = Caller, ["started"] = Started.ToUnixTimeMilliseconds() / 1000.0, ["ended"] = Ended?.ToUnixTimeMilliseconds() / 1000.0,
		["status"] = Status, ["progress"] = Progress, ["message"] = Message, ["error"] = Error, ["result"] = Result, ["reason"] = Reason,
	};
}

/// <summary>Procedures: <c>@procedure</c> functions in <c>&lt;workspace&gt;/procedures/*.py</c>, each run in a process of its own (Python, the same API as a script).
/// This finds them (their parameters make the form), starts and watches runs, passes on pause and abort, keeps devices reserved while a
/// procedure that declared them runs, closes a recording that its run leaves open (also when the run dies), and remembers every run.</summary>
public sealed class ProcedureService(
	Workspace workspace, EnvironmentManager environments, DeviceCatalog catalog, TokenService tokens, RecordingService recordings, DeviceRegistry registry,
	LogStore logs, WorkerGuard guard, ServerInfo info, IConfiguration config, IHubContext<ControlHub> hub, string dataDir, ILogger<ProcedureService> log) : IHostedService, IDisposable
{
	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	private readonly object _gate = new();
	private readonly Dictionary<string, Run> _runs = [];
	private readonly Dictionary<string, (long Stamp, List<Dictionary<string, object?>> Procedures, string? Error)> _described = [];
	private readonly TimeSpan _abortGrace = TimeSpan.FromSeconds(double.Parse(config["abort_grace_s"] ?? "30", System.Globalization.CultureInfo.InvariantCulture));
	private FileSystemWatcher? _watcher;
	private Timer? _debounce;
	private string DbPath => Path.Combine(dataDir, "runs.db");
	private string Folder => Path.Combine(workspace.Path, "procedures");

	// --- lifecycle -----------------------------------------------------------------------------------------------------
	public Task StartAsync(CancellationToken cancel)
	{
		Directory.CreateDirectory(dataDir);
		using (var db = Open())
		{
			Exec(db, "CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, started REAL NOT NULL, record TEXT NOT NULL)");
			// runs that were going when the server ended did not finish: say so
			foreach (var (id, record) in Query(db, "SELECT id, record FROM runs ORDER BY started DESC LIMIT 500"))
			{
				var node = System.Text.Json.Nodes.JsonNode.Parse(record)!.AsObject();
				if (node["ended"] is not null) continue;
				node["status"] = "crashed";
				node["ended"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;
				node["reason"] = "The server ended while the procedure was running";
				Exec(db, "UPDATE runs SET record = $r WHERE id = $i", ("$r", node.ToJsonString()), ("$i", id));
			}
			Exec(db, "DELETE FROM runs WHERE started < $t", ("$t", DateTimeOffset.UtcNow.AddDays(-180).ToUnixTimeSeconds()));
		}
		recordings.RunInfo = by => by.StartsWith("run:") ? RunInfo(by[4..]) : null;
		Directory.CreateDirectory(Folder);
		_watcher = new FileSystemWatcher(Folder, "*.py") { NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size, EnableRaisingEvents = true };
		FileSystemEventHandler changed = (_, _) => { lock (_gate) { _debounce?.Dispose(); _debounce = new Timer(_ => _ = hub.Clients.All.SendAsync("procedures"), null, 300, Timeout.Infinite); } };
		_watcher.Changed += changed;
		_watcher.Created += changed;
		_watcher.Deleted += changed;
		_watcher.Renamed += (s, e) => changed(s, e);
		return Task.CompletedTask;
	}

	/// <summary>The server ends: runs get the chance to clean up (their process sees its input end), then they are killed.</summary>
	public async Task StopAsync(CancellationToken cancel)
	{
		List<Run> active;
		lock (_gate) active = _runs.Values.Where(r => r.IsActive).ToList();
		foreach (var run in active) { run.AbortRequested = true; try { run.Process?.StandardInput.Close(); } catch (Exception e) when (e is IOException or InvalidOperationException) { } }
		var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(Math.Min(15, _abortGrace.TotalSeconds));
		while (DateTime.UtcNow < deadline && active.Any(r => r.IsActive)) await Task.Delay(100, CancellationToken.None);
		foreach (var run in active.Where(r => r.IsActive)) { try { run.Process?.Kill(entireProcessTree: true); } catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception) { } }
	}

	public void Dispose() { _watcher?.Dispose(); _debounce?.Dispose(); }

	// --- finding procedures ----------------------------------------------------------------------------------------------
	/// <summary>The procedures of the workspace: name, title, doc, devices, parameters. A file that cannot be loaded is listed with its error.</summary>
	public async Task<List<Dictionary<string, object?>>> ListAsync(CancellationToken cancel)
	{
		var result = new List<Dictionary<string, object?>>();
		if (!Directory.Exists(Folder)) return result;
		foreach (var file in Directory.EnumerateFiles(Folder, "*.py").Where(f => !Path.GetFileName(f).StartsWith('_')).Order())
		{
			var relative = $"procedures/{Path.GetFileName(file)}";
			var stamp = System.IO.File.GetLastWriteTimeUtc(file).Ticks;
			(long Stamp, List<Dictionary<string, object?>> Procedures, string? Error) found;
			lock (_gate) _described.TryGetValue(file, out found);
			if (found.Procedures is null || found.Stamp != stamp)
			{
				try
				{
					var python = await environments.GetPythonAsync("_describe", file, null, cancel);
					var text = await catalog.RunModuleAsync(python, "laborchestra.procedure_runner", [file, "--describe"], "LABORCHESTRA-PROCEDURES ", relative, cancel);
					var list = JsonSerializer.Deserialize<JsonElement>(text).EnumerateArray().Select(p => (Dictionary<string, object?>)Plain.FromJson(p)!).ToList();
					found = (stamp, list, null);
				}
				catch (Exception e) when (e is InvalidOperationException or JsonException)
				{
					found = (stamp, [], e.Message);
				}
				lock (_gate) _described[file] = found;
			}
			if (found.Error is not null) result.Add(new() { ["file"] = relative, ["error"] = found.Error });
			foreach (var p in found.Procedures) result.Add(new Dictionary<string, object?>(p) { ["file"] = relative });
		}
		return result;
	}

	// --- runs ------------------------------------------------------------------------------------------------------------
	public Dictionary<string, object?> Get(string id)
	{
		lock (_gate) if (_runs.TryGetValue(id, out var run)) return run.Snapshot();
		using var db = Open();
		var found = Query(db, "SELECT id, record FROM runs WHERE id = $i", ("$i", id)).FirstOrDefault();
		return found.Record is null ? throw new ArgumentException($"There is no run '{id}'") : (Dictionary<string, object?>)Plain.FromJson(JsonSerializer.Deserialize<JsonElement>(found.Record))!;
	}

	public List<Dictionary<string, object?>> List(int limit)
	{
		var runs = new Dictionary<string, Dictionary<string, object?>>();
		lock (_gate) foreach (var r in _runs.Values) runs[r.Id] = r.Snapshot();
		using (var db = Open())
			foreach (var (id, record) in Query(db, "SELECT id, record FROM runs ORDER BY started DESC LIMIT $l", ("$l", limit)))
				if (!runs.ContainsKey(id)) runs[id] = (Dictionary<string, object?>)Plain.FromJson(JsonSerializer.Deserialize<JsonElement>(record))!;
		return runs.Values.OrderByDescending(r => Convert.ToDouble(r["started"])).Take(limit).ToList();
	}

	/// <summary>Starts a procedure. Refused when a device it declares does not exist or is reserved by another run. The parameters are checked by the run itself
	/// (a wrong one ends the run at once, with the message).</summary>
	public async Task<Dictionary<string, object?>> StartAsync(string name, Dictionary<string, object?> parameters, string caller, CancellationToken cancel)
	{
		var procedure = (await ListAsync(cancel)).FirstOrDefault(p => p.TryGetValue("name", out var n) && (string?)n == name)
			?? throw new ArgumentException($"There is no procedure '{name}' (procedures: {string.Join(", ", (await ListAsync(cancel)).Where(p => p.ContainsKey("name")).Select(p => p["name"]))})");
		var file = Path.GetFullPath(Path.Combine(workspace.Path, (string)procedure["file"]!));
		var declared = ((List<object?>)procedure["devices"]!).Cast<string>().ToArray();
		var missing = declared.Where(d => registry.Get(d) is null).ToList();
		if (missing.Count > 0) throw new ArgumentException($"The procedure '{name}' uses the device(s) {string.Join(", ", missing)}, which do not exist (devices: {string.Join(", ", registry.All().Keys.Order())})");
		var run = new Run
		{
			Id = Guid.NewGuid().ToString("N")[..12], Procedure = name, File = (string)procedure["file"]!, SourceHash = Hash(System.IO.File.ReadAllText(file)),
			Params = parameters, Devices = declared, Caller = caller,
		};
		lock (_gate)
		{
			foreach (var other in _runs.Values.Where(r => r.IsActive))
				if (other.Devices.Intersect(declared).FirstOrDefault() is { } device)
					throw new ReservationException($"The device '{device}' is reserved by the run {other.Id} of '{other.Procedure}', which is still going. Wait for it, or abort it");
			_runs[run.Id] = run;
		}
		Save(run);
		Announce(run);
		log.LogInformation("Run {Run} of {Procedure} started by {Caller}", run.Id, name, caller);
		_ = Task.Run(() => ExecuteAsync(run, file));
		return run.Snapshot();
	}

	private async Task ExecuteAsync(Run run, string file)
	{
		var source = $"run:{run.Id}";
		try
		{
			var python = await environments.GetPythonAsync(run.Id, file, null, run.Cancel.Token);
			if (run.AbortRequested) { Finish(run, "aborted", reason: "aborted before it started"); return; }
			Set(run, r => r.Status = "starting");
			var start = new ProcessStartInfo(python)
			{
				WorkingDirectory = workspace.Path, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false,
			};
			foreach (var a in new[] { "-u", "-m", "laborchestra.procedure_runner", $"{file}:{run.Procedure}", "--run-id", run.Id }) start.ArgumentList.Add(a);
			start.Environment["LABORCHESTRA_URL"] = info.WorkerUrl;
			start.Environment["LABORCHESTRA_TOKEN"] = tokens.IssueRunToken(run.Id);
			start.Environment["LABORCHESTRA_RUN_PARAMS"] = JsonSerializer.Serialize(run.Params, Json);
			start.Environment["LABORCHESTRA_WATCH_STDIN"] = "1";
			start.Environment["LABORCHESTRA_DIE_WITH_PARENT"] = "1";
			start.Environment["PYTHONUNBUFFERED"] = "1";
			var process = new Process { StartInfo = start, EnableRaisingEvents = true };
			void Line(string? line)
			{
				if (string.IsNullOrWhiteSpace(line)) return;
				lock (run.Tail) { run.Tail.Enqueue(line); while (run.Tail.Count > 15) run.Tail.Dequeue(); }
				logs.Add(source, LevelOf(line), "procedure", line);
			}
			process.OutputDataReceived += (_, e) => Line(e.Data);
			process.ErrorDataReceived += (_, e) => Line(e.Data);
			run.Process = process;
			guard.Start(process, source);
			process.BeginOutputReadLine();
			process.BeginErrorReadLine();
			await process.WaitForExitAsync(CancellationToken.None);
			process.WaitForExit(); // the output has been read to the end
			string[] tail;
			lock (run.Tail) tail = [.. run.Tail];
			if (!run.FinalReceived)
			{
				var message = process.ExitCode == 2 ? "The procedure could not be started: " + string.Join(" | ", tail.TakeLast(3)) : $"The procedure's process ended with exit code {process.ExitCode} without reporting how it ended" + (tail.Length > 0 ? ":\n" + string.Join('\n', tail) : "");
				Finish(run, process.ExitCode == 2 ? "failed" : run.AbortRequested ? "aborted" : "crashed", error: process.ExitCode == 2 || !run.AbortRequested ? new() { ["type"] = process.ExitCode == 2 ? "ParameterError" : "ProcessEnded", ["message"] = message } : null, reason: run.AbortRequested ? run.Reason ?? "killed" : null);
			}
			else Finish(run, run.Status);
		}
		catch (Exception e) when (e is OperationCanceledException)
		{
			Finish(run, "aborted", reason: "aborted while the environment was prepared");
		}
		catch (Exception e)
		{
			log.LogError(e, "The run {Run} could not be started", run.Id);
			logs.Add(source, "ERROR", "supervisor", $"Could not start: {e.Message}");
			Finish(run, "failed", error: new() { ["type"] = e.GetType().Name, ["message"] = e.Message });
		}
	}

	/// <summary>The run is over (its process has ended): record it, close a recording it left open, free its devices.</summary>
	private void Finish(Run run, string status, Dictionary<string, object?>? error = null, string? reason = null)
	{
		var by = $"run:{run.Id}";
		var stopped = recordings.StopOwnedBy(by, $"the run {(status == "finished" ? "ended without stopping it" : status)}" + (reason is null ? "" : $": {reason}"));
		if (stopped) logs.Add(by, "WARNING", "supervisor", "The procedure left a recording open: it was stopped");
		tokens.RevokeRunToken(run.Id);
		environments.Release(run.Id);
		Set(run, r =>
		{
			r.Status = status;
			r.Ended = DateTimeOffset.UtcNow;
			r.Error ??= error;
			r.Reason ??= reason;
		});
		Save(run);
		log.LogInformation("Run {Run} of {Procedure}: {Status}", run.Id, run.Procedure, status);
	}

	// --- what a running procedure reports, and what it is told -----------------------------------------------------------
	public void Attach(string runId, string connectionId)
	{
		Run run;
		lock (_gate) run = _runs.TryGetValue(runId, out var r) ? r : throw new ArgumentException($"There is no run '{runId}'");
		run.ConnectionId = connectionId;
		var pending = run.AbortRequested ? "abort" : run.PendingCommand;
		if (pending is not null) _ = Send(run, pending);
	}

	private DateTime _lastProgress = DateTime.MinValue;

	public void Report(string runId, Dictionary<string, object?> report)
	{
		Run run;
		lock (_gate) run = _runs.TryGetValue(runId, out var r) ? r : throw new ArgumentException($"There is no run '{runId}'");
		var throttle = false;
		Set(run, r =>
		{
			if (report.TryGetValue("progress", out var p) && p is Dictionary<string, object?> progress) { r.Progress = progress; throttle = DateTime.UtcNow - _lastProgress < TimeSpan.FromMilliseconds(200) && report.Count == 1; if (!throttle) _lastProgress = DateTime.UtcNow; }
			if (report.TryGetValue("message", out var m)) r.Message = m as string;
			if (report.TryGetValue("state", out var s) && s is string state && r.Status is "starting" or "running" or "paused") r.Status = r.AbortRequested ? "aborting" : state;
			if (report.TryGetValue("final", out var f) && f is Dictionary<string, object?> final)
			{
				r.FinalReceived = true;
				r.Result = final.GetValueOrDefault("result");
				r.Error = final.GetValueOrDefault("error") as Dictionary<string, object?>;
				r.Reason = final.GetValueOrDefault("reason") as string;
				r.Status = (string?)final.GetValueOrDefault("outcome") ?? "failed";
			}
		}, announce: !throttle);
	}

	public async Task AbortAsync(string id, bool force)
	{
		Run run;
		lock (_gate) run = _runs.TryGetValue(id, out var r) && r.IsActive ? r : throw new ArgumentException($"There is no active run '{id}'");
		if (force)
		{
			logs.Add($"run:{id}", "WARNING", "supervisor", "Killed on request");
			Set(run, r => { r.AbortRequested = true; r.Reason = "killed"; });
			try { run.Process?.Kill(entireProcessTree: true); } catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception) { }
			run.Cancel.Cancel();
			return;
		}
		if (run.AbortRequested) return;
		Set(run, r => { r.AbortRequested = true; if (r.Status is "running" or "paused") r.Status = "aborting"; });
		run.Cancel.Cancel(); // while the environment is still being prepared
		await Send(run, "abort");
		_ = Task.Run(async () => // a procedure that does not stop in time is killed
		{
			await Task.Delay(_abortGrace);
			if (run.IsActive && run.Process is { HasExited: false } process)
			{
				logs.Add($"run:{id}", "ERROR", "supervisor", $"The procedure did not stop within {_abortGrace.TotalSeconds:0} s of the abort and is killed");
				Set(run, r => r.Reason ??= "did not stop in time, killed");
				try { process.Kill(entireProcessTree: true); } catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception) { }
			}
		});
	}

	public Task PauseAsync(string id, bool pause)
	{
		Run run;
		lock (_gate) run = _runs.TryGetValue(id, out var r) && r.IsActive ? r : throw new ArgumentException($"There is no active run '{id}'");
		if (run.AbortRequested) throw new InvalidOperationException("The run is being aborted");
		run.PendingCommand = pause ? "pause" : "resume";
		return Send(run, run.PendingCommand);
	}

	private async Task Send(Run run, string command)
	{
		if (run.ConnectionId is null) return; // sent when it attaches
		try { await hub.Clients.Client(run.ConnectionId).SendAsync("run_command", command); }
		catch (Exception e) { log.LogDebug("Could not send {Command} to the run {Run}: {Message}", command, run.Id, e.Message); }
	}

	// --- who may do what -------------------------------------------------------------------------------------------------
	/// <summary>A run may call the devices its procedure declared, and no others.</summary>
	public void CheckAccess(string runId, string device)
	{
		Run? run;
		lock (_gate) _runs.TryGetValue(runId, out run);
		if (run is null) throw new HubException(Errors.Json("PermissionError", $"The run '{runId}' is not active"));
		if (!run.Devices.Contains(device))
			throw new HubException(Errors.Json("PermissionError", $"The procedure '{run.Procedure}' did not declare the device '{device}': @procedure(devices=[..., '{device}']) (declared: {(run.Devices.Length == 0 ? "none" : string.Join(", ", run.Devices))})"));
	}

	public string? ProcedureOf(string runId) { lock (_gate) return _runs.TryGetValue(runId, out var r) ? r.Procedure : null; }

	private Dictionary<string, object?>? RunInfo(string runId)
	{
		Run? run;
		lock (_gate) _runs.TryGetValue(runId, out run);
		if (run is null) return null;
		var devices = run.Devices.Where(workspace.Devices.ContainsKey).ToDictionary(d => d, d => (object?)workspace.Devices[d]);
		return new() { ["id"] = run.Id, ["procedure"] = run.Procedure, ["file"] = run.File, ["source_hash"] = run.SourceHash, ["params"] = run.Params, ["started_by"] = run.Caller, ["device_configs"] = devices };
	}

	// --- bookkeeping -----------------------------------------------------------------------------------------------------
	private void Set(Run run, Action<Run> change, bool announce = true)
	{
		lock (_gate) change(run);
		if (announce) Announce(run);
	}

	private void Announce(Run run) => _ = hub.Clients.All.SendAsync("run", run.Snapshot());

	private static string Hash(string text) => Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(text)))[..12].ToLowerInvariant();

	private static string LevelOf(string line) =>
		line.StartsWith("CRITICAL") ? "CRITICAL" : line.StartsWith("ERROR") ? "ERROR" : line.StartsWith("WARNING") ? "WARNING" : line.StartsWith("DEBUG") ? "DEBUG" : "INFO";

	private SqliteConnection Open()
	{
		var db = new SqliteConnection($"Data Source={DbPath}");
		db.Open();
		return db;
	}

	private void Save(Run run)
	{
		try
		{
			using var db = Open();
			Exec(db, "INSERT INTO runs (id, started, record) VALUES ($i, $s, $r) ON CONFLICT(id) DO UPDATE SET record = $r", ("$i", run.Id), ("$s", run.Started.ToUnixTimeMilliseconds() / 1000.0), ("$r", JsonSerializer.Serialize(run.Snapshot(), Json)));
		}
		catch (SqliteException e) { log.LogError("The run {Run} could not be saved: {Message}", run.Id, e.Message); }
	}

	private static void Exec(SqliteConnection db, string sql, params (string, object)[] parameters)
	{
		using var command = db.CreateCommand();
		command.CommandText = sql;
		foreach (var (name, value) in parameters) command.Parameters.AddWithValue(name, value);
		command.ExecuteNonQuery();
	}

	private static List<(string Id, string Record)> Query(SqliteConnection db, string sql, params (string, object)[] parameters)
	{
		using var command = db.CreateCommand();
		command.CommandText = sql;
		foreach (var (name, value) in parameters) command.Parameters.AddWithValue(name, value);
		using var reader = command.ExecuteReader();
		var rows = new List<(string, string)>();
		while (reader.Read()) rows.Add((reader.GetString(0), reader.GetString(1)));
		return rows;
	}
}

/// <summary>A device that a procedure needs is reserved by another run.</summary>
public sealed class ReservationException(string message) : Exception(message);
