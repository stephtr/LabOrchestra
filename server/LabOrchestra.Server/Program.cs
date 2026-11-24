using System.Text.RegularExpressions;
using LabOrchestra.Server;
using LabOrchestra.Server.Auth;
using LabOrchestra.Server.Devices;
using LabOrchestra.Server.Events;
using LabOrchestra.Server.Recording;
using LabOrchestra.Server.Streaming;
using LabOrchestra.Server.Hubs;
using LabOrchestra.Server.Logging;
using Microsoft.AspNetCore.SignalR;
using LabOrchestra.Server.Supervision;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.FileProviders;

var builder = WebApplication.CreateBuilder(args);
builder.Configuration.AddEnvironmentVariables("LABORCHESTRA_"); // LABORCHESTRA_WORKSPACE, _PYTHON, _PASSPHRASE, _DATA_DIR, ...
var config = builder.Configuration;

var urls = config["urls"] ?? "http://127.0.0.1:5095";
builder.WebHost.UseUrls(urls);
var firstUrl = urls.Split(';')[0];
var workerUrl = Regex.Replace(firstUrl, @"://(\*|\+|0\.0\.0\.0|\[::\])", "://127.0.0.1").TrimEnd('/');

var dataDir = config["data_dir"] ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LabOrchestra");
var passphrase = TokenService.LoadOrCreatePassphrase(config["passphrase"], dataDir);

Workspace workspace;
try
{
	workspace = Workspace.Load(Path.GetFullPath(config["workspace"] ?? FindWorkspace()));
}
catch (InvalidOperationException e)
{
	Console.Error.WriteLine(e.Message);
	return 2;
}

var logStore = new LogStore(Path.Combine(dataDir, "logs"));
builder.Logging.AddProvider(new LogStoreProvider(logStore));
builder.Services.AddSingleton(logStore);
builder.Services.AddSingleton(new SettingsStore(Path.Combine(dataDir, "settings")));
builder.Services.AddSingleton(new SecretStore(Path.Combine(dataDir, "secrets.json")));
builder.Services.AddSingleton(new TokenService(passphrase));
builder.Services.AddSingleton(workspace);
builder.Services.AddSingleton(new ServerInfo(workerUrl));
builder.Services.AddSingleton(sp => new EnvironmentManager(config, dataDir, sp.GetRequiredService<LogStore>(), sp.GetRequiredService<ILogger<EnvironmentManager>>()));
builder.Services.AddSingleton<EventBus>();
builder.Services.AddSingleton<StreamManager>();
builder.Services.AddSingleton<DeviceRegistry>();
builder.Services.AddSingleton(sp => new LabOrchestra.Server.Drivers.DriverCatalog(
	[Path.Combine(AppContext.BaseDirectory, "plugins"), Path.Combine(workspace.Path, "plugins")], sp.GetRequiredService<ILogger<LabOrchestra.Server.Drivers.DriverCatalog>>()));
var recordingsDir = Path.GetFullPath(config["recordings_dir"] ?? Path.Combine(dataDir, "recordings"));
builder.Services.AddSingleton(sp => new RecordingService(recordingsDir, sp.GetRequiredService<DeviceRegistry>(), sp.GetRequiredService<IHubContext<ControlHub>>(), sp.GetRequiredService<ILogger<RecordingService>>()));
builder.Services.AddSingleton<WorkerSupervisor>();
builder.Services.AddSingleton<DeviceCatalog>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<WorkerSupervisor>());
builder.Services.AddSignalR(o => o.MaximumReceiveMessageSize = 16 * 1024 * 1024).AddMessagePackProtocol();
builder.Services.AddAuthentication(TokenAuthHandler.SchemeName)
	.AddScheme<AuthenticationSchemeOptions, TokenAuthHandler>(TokenAuthHandler.SchemeName, null);
builder.Services.AddAuthorization();

var app = builder.Build();

// Browsers may only open the hubs from the page served by this server (or from listed origins, e.g. a dev server).
var allowedOrigins = (config["allowed_origins"] ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
app.Use(async (context, next) =>
{
	if (context.Request.Path.StartsWithSegments("/hub") && context.Request.Headers.TryGetValue("Origin", out var origin))
	{
		var sameOrigin = Uri.TryCreate(origin.ToString(), UriKind.Absolute, out var uri) && uri.Authority == context.Request.Host.Value;
		if (!sameOrigin && !allowedOrigins.Contains(origin.ToString()))
		{
			context.Response.StatusCode = StatusCodes.Status403Forbidden;
			return;
		}
	}
	await next();
});
app.Services.GetRequiredService<RecordingService>().RepairInterrupted();
workspace.Watch(app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("LabOrchestra.Workspace"));
var controlHub = app.Services.GetRequiredService<IHubContext<ControlHub>>();
logStore.Added += entry => _ = controlHub.Clients.Group("logs:" + entry["source"]).SendAsync("log", entry);
app.UseAuthentication();
app.UseAuthorization();
app.MapHub<DeviceHub>("/hub/devices");
app.MapHub<ControlHub>("/hub/control");
app.MapHub<StreamHub>("/hub/streaming");

var clientDir = config["client_dir"] ?? FindClientDir();
if (clientDir is not null && Directory.Exists(clientDir))
{
	var files = new PhysicalFileProvider(Path.GetFullPath(clientDir));
	app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = files });
	app.UseStaticFiles(new StaticFileOptions { FileProvider = files });
	app.MapFallbackToFile("index.html", new StaticFileOptions { FileProvider = files });
}

app.Lifetime.ApplicationStarted.Register(() =>
{
	Console.WriteLine($"\nLabOrchestra is running at {firstUrl}");
	Console.WriteLine($"Login: {firstUrl}/#token={passphrase}");
	Console.WriteLine($"Workspace: {workspace.Path} ({(workspace.HasDevicesFile ? $"{workspace.Devices.Count} device(s)" : "no devices.json yet")})");
	Console.WriteLine($"Recordings: {recordingsDir}");
	Console.WriteLine(clientDir is null ? "No client found (build it with 'pnpm build' in client/)\n" : $"Client: {Path.GetFullPath(clientDir)}\n");
});

app.Run();
return 0;

/// <summary>Without a setting: the workspace/ folder of a source checkout (an example), else Documents/LabOrchestra.</summary>
static string FindWorkspace()
{
	foreach (var start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
		for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
			if (File.Exists(Path.Combine(dir.FullName, "workspace", "devices.json"))) return Path.Combine(dir.FullName, "workspace");
	return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "LabOrchestra");
}

static string? FindClientDir()
{
	foreach (var start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
	{
		var dir = new DirectoryInfo(start);
		for (var i = 0; i < 8 && dir is not null; i++, dir = dir.Parent)
		{
			var candidate = Path.Combine(dir.FullName, "client", "dist");
			if (File.Exists(Path.Combine(candidate, "index.html"))) return candidate;
		}
	}
	return null;
}
