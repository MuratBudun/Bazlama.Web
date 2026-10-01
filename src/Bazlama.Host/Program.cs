using System.Reflection;
using Bazlama.Host;
using Bazlama.Kernel;
using Bazlama.Kernel.Data;
using Bazlama.Modules.Identity;
using Bazlama.Modules.Management;
using Bazlama.Modules.Runtime;

var builder = WebApplication.CreateBuilder(args);

var database = builder.Configuration.GetSection("Database").Get<DatabaseOptions>() ?? new DatabaseOptions();
var mode = builder.Configuration.GetValue("Platform:EnvironmentMode", EnvironmentMode.Development);

builder.Services.AddKernelDatabase(database);
builder.Services.AddIdentityModule(builder.Configuration["Platform:CookieName"] ?? "bazlama.session");

var app = builder.Build();

if (database.MigrateOnStartup)
    await app.MigrateKernelDatabaseAsync();

var version = typeof(Program).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.0.0";
// "0.1.0+<commit>": the build metadata is noise on screen.
version = version.Split('+')[0];

app.UseIdentityModule();
app.MapAuthEndpoints();
app.MapManagementEndpoints();
app.MapRuntimeEndpoints();

var api = app.MapGroup("/api");
api.MapGet("/system/info", (IDatabaseProvider provider) =>
    new SystemInfo("Bazlama", version, mode.ToString(), provider.Name)).RequireActiveSession();

// The web UI (web/ → npm run build → wwwroot). Unknown /api paths stay 404.
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapFallback("/api/{**path}", () => Results.NotFound());
app.MapFallbackToFile("index.html");

app.Run();

record SystemInfo(string Product, string Version, string Environment, string DatabaseProvider);

/// <summary>Visible to the integration tests (WebApplicationFactory).</summary>
public partial class Program;
