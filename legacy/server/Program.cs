using LabOrchestra.Hubs;
using Python.Runtime;

TaskScheduler.UnobservedTaskException += (object? sender, UnobservedTaskExceptionEventArgs e) =>
{
	Console.WriteLine($"Unhandled {e.Exception}");
	Console.WriteLine(e.Exception.Message);
	Console.WriteLine(e.Exception.Source);
};
AppDomain.CurrentDomain.UnhandledException += (object sender, UnhandledExceptionEventArgs e) =>
{
	Console.WriteLine($"Unhandled {e.ExceptionObject}");
	var exception = e.ExceptionObject as Exception;
	if (exception != null)
	{
		Console.WriteLine(exception.Message);
		Console.WriteLine(exception.Source);
	}
};

EnvLoader.Load(".env");
EnvLoader.Load(".env.local");

ThreadPool.SetMinThreads(32, 1);

Runtime.PythonDLL = Environment.OSVersion.Platform switch
{
	PlatformID.Win32NT => @"C:\Users\Cavity\.pyenv\pyenv-win\versions\3.13.0rc1\python313.dll",
	PlatformID.Unix => "/Library/Frameworks/Python.framework/Versions/3.13/lib/libpython3.13.dylib",
	_ => null,
};
PythonEngine.Initialize();
PythonEngine.BeginAllowThreads();

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSignalR()
	.AddJsonProtocol(options =>
	{
		options.PayloadSerializerOptions.Converters.Add(new NaturalObjectConverter());
	})
	.AddMessagePackProtocol()
	.AddHubOptions<ControlHub>(options => options.MaximumParallelInvocationsPerClient = 10)
	.AddHubOptions<StreamingHub>(options => options.MaximumParallelInvocationsPerClient = 10);
builder.Services.AddCors(options =>
	options.AddDefaultPolicy(builder =>
		builder
			.WithOrigins(["http://localhost:3000", "http://glaser.exp.univie.ac.at:3000", "http://localhost:5095", "http://glaser.exp.univie.ac.at:5095"])
			.AllowAnyMethod()
			.AllowAnyHeader()
			.AllowCredentials()
	)
);
builder.Services.AddSpaYarp();

builder.Services.AddSingleton<AccessControlService>();
builder.Services.AddSingleton<DeviceManager>();

var app = builder.Build();
app.UseCors();
app.MapHub<StreamingHub>("/hub/streaming");
app.MapHub<ControlHub>("/hub/control");

app.MapGet("/api/ping", async (HttpContext context, AccessControlService accessControlService) =>
{
	var isLocalRequest = ConnectionUtils.IsLocal(context.Connection);
	if (!isLocalRequest)
	{
		var authHeader = context.Request.Headers["Authorization"].ToString();
		if (!accessControlService.IsBearerValid(authHeader))
		{
			context.Response.StatusCode = 401; // Unauthorized
			return;
		}
	}
	await context.Response.WriteAsync("Pong");
});

app.UseSpaYarp();

// Start up the DeviceManager
app.Services.GetRequiredService<DeviceManager>();

app.Run();
