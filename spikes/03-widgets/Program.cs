using System.Diagnostics; using System.Text.RegularExpressions; using Jint; using Microsoft.AspNetCore.SignalR; using Microsoft.Extensions.FileProviders;
// args: esbuild path, widget folder
var b = WebApplication.CreateBuilder(); b.Logging.SetMinimumLevel(LogLevel.Warning); b.WebHost.UseUrls("http://127.0.0.1:5198");
b.Services.AddSignalR().AddMessagePackProtocol(); var app = b.Build();
var www = new PhysicalFileProvider(Path.GetFullPath("dist/www")); app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = www }); app.UseStaticFiles(new StaticFileOptions { FileProvider = www });
app.MapHub<H>("/hub"); app.MapGet("/widgets/demo.js", () => Results.Text(Widget.Js, "text/javascript")); app.MapGet("/widgets.css", () => Results.Text(Widget.Css, "text/css")); app.MapGet("/errors", () => string.Join("\n", H.Errors));
Widget.Init(args[0], args[1], Directory.GetFiles("dist/www/assets", "*.js").Select(File.ReadAllText)); Widget.Build();
var hub = app.Services.GetRequiredService<IHubContext<H>>(); var gate = new object(); Timer t = null;
using var fw = new FileSystemWatcher(args[1]) { EnableRaisingEvents = true, IncludeSubdirectories = true };
void Changed(object s, FileSystemEventArgs e) { lock (gate) { t?.Dispose(); t = new Timer(_ => { lock (gate) { Widget.Build(); hub.Clients.All.SendAsync("widget", Widget.State); } }, null, 50, -1); } }
fw.Changed += Changed; fw.Created += Changed; fw.Renamed += Changed;
app.Run();
static class Widget {
  static string Esb, Dir; static Engine E; static readonly HashSet<string> Cand = new(); static int n;
  public static string Js = "", Css = ""; public static Update State;
  static void Scan(string s) { foreach (var w in Regex.Split(s, "[\\s\"'`<>={};]+")) if (w.Length is > 0 and < 100) Cand.Add(w); }
  public static void Init(string esb, string dir, IEnumerable<string> host) { Esb = esb; Dir = dir; foreach (var h in host) Scan(h);
    E = new Engine(); E.Execute(File.ReadAllText("dist/tailwind.js")); E.Execute("var C,X; mk().then(c=>{C=c},x=>{X=String(x)})"); E.Advanced.ProcessTasks(); }
  public static void Build() { var w = Stopwatch.StartNew(); var si = new ProcessStartInfo(Esb) { RedirectStandardOutput = true, RedirectStandardError = true };
    foreach (var a in new[] { Path.Combine(Dir, "demo.tsx"), "--bundle", "--format=esm", "--jsx=automatic", "--external:react", "--external:react/jsx-runtime", "--external:react-dom", "--external:@laborchestra/sdk", "--log-level=error", "--color=false" }) si.ArgumentList.Add(a);
    var p = Process.Start(si); var err = p.StandardError.ReadToEndAsync(); var js = p.StandardOutput.ReadToEnd(); p.WaitForExit(); var v = (++n).ToString(); var te = w.ElapsedMilliseconds;
    if (p.ExitCode != 0) { State = new Update { Version = v, Error = err.Result }; return; }
    Js = js; Scan(js); Css = E.Invoke("eval", "(a)=>C.build(a.split('\\n'))").AsFunctionCall(E, string.Join("\n", Cand)); State = new Update { Version = v };
    Console.WriteLine($"build {v}: esbuild {te} ms, css {w.ElapsedMilliseconds - te} ms, {Cand.Count} words, {Css.Length} chars"); }
  static string AsFunctionCall(this Jint.Native.JsValue f, Engine e, string a) => e.Invoke(f, a).AsString();
}
public class Update { public string Version { get; set; } public string Error { get; set; } }
class H : Hub { public static readonly List<string> Errors = new();
  public Update Current() => Widget.State; public void ReportError(string e) { lock (Errors) Errors.Add(e); }
  public Task Bin() { var f = new float[] { 1, 2, 3.5f }; var by = new byte[12]; Buffer.BlockCopy(f, 0, by, 0, 12); return Clients.Caller.SendAsync("bin", by); } }
