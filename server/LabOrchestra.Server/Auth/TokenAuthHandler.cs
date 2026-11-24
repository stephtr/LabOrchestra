using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace LabOrchestra.Server.Auth;

public sealed class TokenAuthHandler(
	IOptionsMonitor<AuthenticationSchemeOptions> options,
	ILoggerFactory logger,
	UrlEncoder encoder,
	TokenService tokens) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
	public const string SchemeName = "LabOrchestra";

	protected override Task<AuthenticateResult> HandleAuthenticateAsync()
	{
		var token = GetToken();
		if (token is null) return Task.FromResult(AuthenticateResult.NoResult());
		var principal = tokens.Validate(token);
		return Task.FromResult(principal is null
			? AuthenticateResult.Fail("Invalid token")
			: AuthenticateResult.Success(new AuthenticationTicket(principal, SchemeName)));
	}

	private string? GetToken()
	{
		var header = Request.Headers.Authorization.ToString();
		if (header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return header[7..].Trim();
		// Browsers cannot set headers on WebSockets, so hubs also take the token from the query string
		if (Request.Path.StartsWithSegments("/hub") && Request.Query.TryGetValue("access_token", out var q)) return q.ToString();
		return null;
	}
}
