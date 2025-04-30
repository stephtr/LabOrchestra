using ExperimentControl.Hubs;
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

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSignalR()
	.AddJsonProtocol(options =>
	{
		options.PayloadSerializerOptions.Converters.Add(new NaturalObjectConverter());
	})
	.AddMessagePackProtocol();
builder.Services.AddCors(options =>
	options.AddDefaultPolicy(builder =>
		builder
			.WithOrigins("http://localhost:3000")
			.AllowAnyMethod()
			.AllowAnyHeader()
			.AllowCredentials()
	)
);
builder.Services.AddSingleton<DeviceManager>();

Runtime.PythonDLL = Environment.OSVersion.Platform switch
{
	PlatformID.Win32NT => @"C:\Users\Cavity\.pyenv\pyenv-win\versions\3.12.5\python312.dll",
	PlatformID.Unix => "/Library/Frameworks/Python.framework/Versions/3.13/lib/libpython3.13.dylib",
	_ => null,
};
PythonEngine.Initialize();
PythonEngine.BeginAllowThreads();

var app = builder.Build();
app.UseCors();
app.MapHub<StreamingHub>("/hub/streaming");
app.MapHub<ControlHub>("/hub/control");

// Start up the DeviceManager
app.Services.GetRequiredService<DeviceManager>();

app.Run();
