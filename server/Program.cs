using ExperimentControl.Hubs;
using Python.Runtime;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSignalR()
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
	PlatformID.Win32NT => @"C:\Program Files\WindowsApps\PythonSoftwareFoundation.Python.3.12_3.12.1008.0_x64__qbz5n2kfra8p0\python312.dll",
	PlatformID.Unix => "/Library/Frameworks/Python.framework/Versions/3.12/lib/libpython3.12.dylib",
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
