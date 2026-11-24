using Microsoft.AspNetCore.SignalR;
using System.Diagnostics;
var b = WebApplication.CreateBuilder(args);
b.Logging.SetMinimumLevel(LogLevel.Warning);
b.WebHost.UseUrls("http://127.0.0.1:5199");
b.Services.AddSignalR(o => { o.MaximumReceiveMessageSize = 64_000_000; o.EnableDetailedErrors = true; }).AddMessagePackProtocol();
var app = b.Build();
app.MapHub<H>("/hub");
app.MapGet("/call/{m}", async (string m, IHubContext<H> h) => {
  try { var c = new CancellationTokenSource(3000);
    var r = await h.Clients.Client(H.Last!).InvokeAsync<object>(m, 20, 22, c.Token); return $"result {r} ({r?.GetType().Name})"; }
  catch (Exception e) { return $"{e.GetType().Name}: {e.Message}"; } });
app.MapGet("/bytes", async (IHubContext<H> h) => {
  try { var data = new byte[1_000_000]; new Random(1).NextBytes(data); var c = new CancellationTokenSource(5000);
    var r = await h.Clients.Client(H.Last!).InvokeAsync<byte[]>("echo_bytes", data, c.Token); return $"equal={r.AsSpan().SequenceEqual(data)}"; }
  catch (Exception e) { return $"{e.GetType().Name}: {e.Message}"; } });
app.MapGet("/lat", async (IHubContext<H> h) => {
  var l = new List<double>(); var c = new CancellationTokenSource(60000);
  for (int i = 0; i < 5500; i++) { var t = Stopwatch.GetTimestamp(); await h.Clients.Client(H.Last!).InvokeAsync<object>("add", 20, 22, c.Token);
    if (i >= 500) l.Add(Stopwatch.GetElapsedTime(t).TotalMilliseconds); }
  l.Sort(); return $"n={l.Count} p50={l[l.Count/2]:F3} p99={l[(int)(l.Count*.99)]:F3} max={l[^1]:F3} ms"; });
app.MapGet("/par", async (IHubContext<H> h) => { var t = Stopwatch.GetTimestamp(); var c = new CancellationTokenSource(10000);
  await Task.WhenAll(Enumerable.Range(0,10).Select(_ => h.Clients.Client(H.Last!).InvokeAsync<object>("slow", 1, 2, c.Token))); return $"10x100ms calls took {Stopwatch.GetElapsedTime(t).TotalMilliseconds:F0} ms"; });
app.MapGet("/kick", () => { H.Ctx!.Abort(); return "kicked"; });
app.Run();
class H : Hub { public static string? Last; public static HubCallerContext? Ctx;
  public override Task OnConnectedAsync() { Last = Context.ConnectionId; Ctx = Context; return base.OnConnectedAsync(); }
  public int Add(int a, int b) => a + b; public byte[] Echo(byte[] d) => d; public int Fail() => throw new HubException("boom"); }
