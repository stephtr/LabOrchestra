using ExperimentControl.Hubs;

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
builder.Services.AddHostedService<DataGeneratorService>();

var app = builder.Build();
app.UseCors();
app.MapHub<OscilloscopeHub>("/hub/oscilloscope");

app.Run();
