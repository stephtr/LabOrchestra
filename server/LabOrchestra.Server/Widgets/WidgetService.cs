using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Jint;
using Microsoft.AspNetCore.SignalR;
using LabOrchestra.Server.Hubs;

namespace LabOrchestra.Server.Widgets;

/// <summary>Where the built client is (null: none); the Tailwind compiler and the host's classes are found there.</summary>
public sealed record ClientDirectory(string? Path);

/// <summary>Runtime widgets: the .tsx/.ts/.jsx/.js files in <c>&lt;workspace&gt;/widgets/</c> are compiled with esbuild into ES modules (react, react-dom
/// and the widget SDK are left out: the host provides them through its import map), kept in memory and given to clients over the control hub.
/// Whenever a file changes everything is built again and the clients are told, so that they load the new version without a reload. Their styling
/// is one Tailwind stylesheet for the host and all widgets, made here (the compiler runs in an embedded JS engine; browsers load no compiler),
/// because the host's build cannot know the classes of widgets that are written later.</summary>
public sealed partial class WidgetService(Workspace workspace, ClientDirectory client, IConfiguration config, IHubContext<ControlHub> hub, ILogger<WidgetService> log) : IHostedService, IDisposable
{
	private sealed record Built(string Name, string Version, string? Code, string? Error);

	private static readonly string[] Extensions = [".tsx", ".ts", ".jsx", ".js"];
	private static readonly string[] Externals = ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "@laborchestra/widget"];

	private readonly object _gate = new();
	private readonly SemaphoreSlim _building = new(1, 1);
	private Dictionary<string, Built> _widgets = [];
	private string _css = "", _cssVersion = "";
	private string? _problem; // why nothing can be built (esbuild missing), shown to the user
	private FileSystemWatcher? _watcher;
	private Timer? _debounce;
	private Engine? _tailwind;
	private string? _tailwindProblem;
	private readonly Lazy<string?> _esbuild = new(() => FindEsbuild(config["esbuild"]));

	private string Folder => Path.Combine(workspace.Path, "widgets");

	[GeneratedRegex("^[a-z][a-z0-9]*(_[a-z0-9]+)*$")]
	private static partial Regex SnakeCase();

	public Task StartAsync(CancellationToken cancel)
	{
		Directory.CreateDirectory(Folder);
		_ = Task.Run(() => RebuildAsync(announce: false));
		_watcher = new FileSystemWatcher(Folder) { IncludeSubdirectories = true, NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size | NotifyFilters.DirectoryName, EnableRaisingEvents = true };
		FileSystemEventHandler changed = (_, e) =>
		{
			if (e.FullPath.Contains($"{Path.DirectorySeparatorChar}node_modules{Path.DirectorySeparatorChar}")) return;
			lock (_gate) { _debounce?.Dispose(); _debounce = new Timer(_ => _ = RebuildAsync(announce: true), null, 150, Timeout.Infinite); }
		};
		_watcher.Changed += changed;
		_watcher.Created += changed;
		_watcher.Deleted += changed;
		_watcher.Renamed += (s, e) => changed(s, e);
		return Task.CompletedTask;
	}

	public Task StopAsync(CancellationToken cancel) => Task.CompletedTask;

	public void Dispose()
	{
		_watcher?.Dispose();
		_debounce?.Dispose();
	}

	// --- what clients ask for ----------------------------------------------------------------------------------------------
	public Dictionary<string, object?> List()
	{
		lock (_gate)
			return new()
			{
				["widgets"] = _widgets.Values.OrderBy(w => w.Name).Select(w => new Dictionary<string, object?> { ["name"] = w.Name, ["version"] = w.Version, ["error"] = w.Error }).ToList(),
				["css_version"] = _cssVersion,
				["problem"] = _problem,
			};
	}

	public Dictionary<string, object?> Get(string name)
	{
		lock (_gate)
			return _widgets.TryGetValue(name, out var w)
				? new() { ["name"] = w.Name, ["version"] = w.Version, ["code"] = w.Code, ["error"] = w.Error }
				: throw new ArgumentException($"There is no widget '{name}' (widgets: {string.Join(", ", _widgets.Keys.Order())})");
	}

	public string Css() { lock (_gate) return _css; }

	// --- building ----------------------------------------------------------------------------------------------------------
	private async Task RebuildAsync(bool announce)
	{
		await _building.WaitAsync();
		try
		{
			var sources = Discover();
			var esbuild = _esbuild.Value;
			Dictionary<string, Built> built;
			string? problem = null;
			if (esbuild is null)
			{
				problem = sources.Count == 0 ? null : "esbuild was not found, so widgets cannot be built. Install it (pnpm install in client/), put it next to the server, or set the option 'esbuild' to its path.";
				built = sources.ToDictionary(s => s.Key, s => new Built(s.Key, "0", null, problem));
				if (problem is not null) log.LogWarning("{Problem}", problem);
			}
			else
			{
				var results = await Task.WhenAll(sources.Select(async s => await CompileAsync(esbuild, s.Key, s.Value)));
				built = results.ToDictionary(b => b.Name);
			}
			var css = await Task.Run(() => BuildCss(built.Values));
			lock (_gate)
			{
				_widgets = built;
				_problem = problem;
				if (css is not null) (_css, _cssVersion) = (css, Hash(css));
			}
			foreach (var b in built.Values.Where(b => b.Error is not null && esbuild is not null)) log.LogError("Widget {Widget} was not built:\n{Error}", b.Name, b.Error);
			log.LogInformation("Widgets: {Count} built ({Names})", built.Count, string.Join(", ", built.Keys.Order()));
			if (announce) await hub.Clients.All.SendAsync("widgets", List());
		}
		catch (Exception e)
		{
			log.LogError(e, "Building the widgets failed");
		}
		finally
		{
			_building.Release();
		}
	}

	/// <summary>The entry file of every widget: widgets/&lt;name&gt;.tsx, or widgets/&lt;name&gt;/index.tsx.</summary>
	private Dictionary<string, string> Discover()
	{
		var found = new Dictionary<string, string>();
		if (!Directory.Exists(Folder)) return found;
		foreach (var file in Directory.EnumerateFiles(Folder).Order())
			if (Extensions.Contains(Path.GetExtension(file)) && !file.EndsWith(".d.ts") && SnakeCase().IsMatch(Path.GetFileNameWithoutExtension(file))) found[Path.GetFileNameWithoutExtension(file)] = file;
		foreach (var dir in Directory.EnumerateDirectories(Folder).Order())
		{
			var name = Path.GetFileName(dir);
			var index = Extensions.Select(e => Path.Combine(dir, "index" + e)).FirstOrDefault(File.Exists);
			if (index is not null && SnakeCase().IsMatch(name)) found[name] = index;
		}
		return found;
	}

	private async Task<Built> CompileAsync(string esbuild, string name, string entry)
	{
		var info = new ProcessStartInfo(esbuild) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, WorkingDirectory = Folder };
		foreach (var a in new[] { entry, "--bundle", "--format=esm", "--jsx=automatic", "--target=es2022", "--sourcemap=inline", "--log-level=error", "--color=false" }.Concat(Externals.Select(e => $"--external:{e}")))
			info.ArgumentList.Add(a);
		try
		{
			using var process = Process.Start(info)!;
			var errors = process.StandardError.ReadToEndAsync();
			var output = process.StandardOutput.ReadToEndAsync();
			using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
			try { await process.WaitForExitAsync(timeout.Token); }
			catch (OperationCanceledException) { process.Kill(entireProcessTree: true); return new Built(name, "0", null, "esbuild did not finish within 60 s"); }
			if (process.ExitCode != 0) return new Built(name, "0", null, (await errors).Trim());
			var code = await output;
			return new Built(name, Hash(code), code, null);
		}
		catch (Exception e) when (e is System.ComponentModel.Win32Exception or IOException)
		{
			return new Built(name, "0", null, $"esbuild could not be started: {e.Message}");
		}
	}

	// --- the stylesheet ----------------------------------------------------------------------------------------------------
	/// <summary>One Tailwind stylesheet for the host and all widgets: the compiler gets every word that could be a class from the host's
	/// built files and the widgets. (A word that is made up at run time, "bg-${color}-500", is not found: the usual Tailwind rule.)</summary>
	private string? BuildCss(IEnumerable<Built> widgets)
	{
		if (client.Path is null) return null;
		try
		{
			_tailwind ??= StartTailwind();
			if (_tailwind is null) return null;
			var words = new HashSet<string>();
			void Scan(string text) { foreach (var w in Splitter().Split(text)) if (w.Length is > 0 and < 100) words.Add(w); }
			foreach (var file in Directory.EnumerateFiles(client.Path, "*.*", SearchOption.AllDirectories).Where(f => f.EndsWith(".js") || f.EndsWith(".html")))
				if (!file.Contains($"{Path.DirectorySeparatorChar}_lo{Path.DirectorySeparatorChar}")) Scan(File.ReadAllText(file));
			foreach (var w in widgets.Where(w => w.Code is not null)) Scan(w.Code!);
			lock (_tailwind)
			{
				var build = _tailwind.Evaluate("(candidates) => compiler.build(candidates.split('\\n'))");
				return _tailwind.Invoke(build, string.Join('\n', words)).AsString();
			}
		}
		catch (Exception e)
		{
			if (_tailwindProblem != e.Message) log.LogError(e, "The widget stylesheet could not be built");
			_tailwindProblem = e.Message;
			return null;
		}
	}

	[GeneratedRegex("[\\s\"'`<>={};]+")]
	private static partial Regex Splitter();

	private Engine? StartTailwind()
	{
		var file = Path.Combine(client.Path!, "_lo", "tailwind-compiler.js");
		if (!File.Exists(file))
		{
			log.LogWarning("{File} is missing, so widgets get no stylesheet (build the client with 'pnpm build')", file);
			return null;
		}
		var engine = new Engine();
		engine.Execute(File.ReadAllText(file));
		engine.Execute("var compiler, compilerError; makeCompiler().then(c => { compiler = c }, e => { compilerError = String(e) })");
		engine.Advanced.ProcessTasks();
		if (engine.GetValue("compiler").IsUndefined()) throw new InvalidOperationException("The Tailwind compiler did not start: " + engine.GetValue("compilerError"));
		return engine;
	}

	// --- helpers -----------------------------------------------------------------------------------------------------------
	private static string Hash(string text) => Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(text)))[..12].ToLowerInvariant();

	/// <summary>The esbuild executable: the configured one, one next to the server (a release), or the one of the client's node_modules (a checkout).</summary>
	private static string? FindEsbuild(string? configured)
	{
		if (!string.IsNullOrWhiteSpace(configured)) return File.Exists(configured) ? configured : null;
		var exe = OperatingSystem.IsWindows() ? "esbuild.exe" : "esbuild";
		var beside = Path.Combine(AppContext.BaseDirectory, exe);
		if (File.Exists(beside)) return beside;
		var bin = OperatingSystem.IsWindows() ? "esbuild.cmd" : "esbuild";
		foreach (var start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
			for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
			{
				var candidate = Path.Combine(dir.FullName, "client", "node_modules", ".bin", bin);
				if (File.Exists(candidate)) return candidate;
			}
		return null;
	}
}
