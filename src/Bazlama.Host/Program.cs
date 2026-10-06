using System.Reflection;
using Bazlama.Compiler;
using Bazlama.Host;
using Bazlama.Kernel;
using Bazlama.Kernel.Data;
using Bazlama.Modules.Development;
using Bazlama.Modules.Identity;
using Bazlama.Modules.Management;
using Bazlama.Modules.Runtime;
using Bazlama.Packaging;

var builder = WebApplication.CreateBuilder(args);

var database = builder.Configuration.GetSection("Database").Get<DatabaseOptions>() ?? new DatabaseOptions();
var mode = builder.Configuration.GetValue("Platform:EnvironmentMode", EnvironmentMode.Development);
var version = typeof(Program).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.0.0";
// "0.1.0+<commit>": the build metadata is noise on screen.
version = version.Split('+')[0];

builder.Services.AddSingleton(new PlatformInfo(mode, version));
builder.Services.AddKernelDatabase(database);
builder.Services.AddCompilerModule();
builder.Services.AddScoped<PackageService>();
builder.Services.AddIdentityModule(builder.Configuration["Platform:CookieName"] ?? "bazlama.session");

var app = builder.Build();

if (database.MigrateOnStartup)
    await app.MigrateKernelDatabaseAsync();

if (AdminCommands.IsCommand(args))
    return await AdminCommands.RunAsync(app, args);

app.UseIdentityModule();
app.MapAuthEndpoints();
app.MapManagementEndpoints();
app.MapRuntimeEndpoints();
app.MapDevelopmentEndpoints();

var api = app.MapGroup("/api");
api.MapGet("/system/info", (IDatabaseProvider provider) =>
    new SystemInfo("Bazlama", version, mode.ToString(), provider.Name)).RequireActiveSession();

// The web UI (web/ → npm run build → wwwroot). Unknown /api paths stay 404.
// Files under /assets carry a content hash in their name: the browser may keep them for good,
// and they are served compressed (about a quarter of the size; the code editor alone is 3.9 MB).
// The pages (index.html, preview.html) name those files, so they are checked every time.
// Only these files are compressed, never /api.
var ui = new StaticFileOptions
{
    OnPrepareResponse = context =>
        context.Context.Response.Headers.CacheControl = context.Context.Request.Path.StartsWithSegments(AssetCompression.Prefix)
            ? AssetCompression.Forever
            : "no-cache",
};
app.UseMiddleware<AssetCompression>();
app.UseDefaultFiles();
app.UseStaticFiles(ui);
app.MapFallback("/api/{**path}", () => Results.NotFound());
app.MapFallbackToFile("index.html", ui);

await app.RunAsync();
return 0;

record SystemInfo(string Product, string Version, string Environment, string DatabaseProvider);

/// <summary>Visible to the integration tests (WebApplicationFactory).</summary>
public partial class Program;
