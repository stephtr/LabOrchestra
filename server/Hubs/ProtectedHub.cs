using Microsoft.AspNetCore.SignalR;

namespace LabOrchestra.Hubs;

public class ProtectedHub : Hub
{
	private readonly AccessControlService AccessControlService;
	public ProtectedHub(AccessControlService accessControlService)
	{
		AccessControlService = accessControlService;
	}

	public override async Task OnConnectedAsync()
	{
		var isLocalRequest = ConnectionUtils.IsLocal(Context.GetHttpContext()?.Connection);
		if (!isLocalRequest)
		{
			var authHeader = Context.GetHttpContext()?.Request.Headers["Authorization"].ToString();
			var authRequestQuery = Context.GetHttpContext()?.Request.Query["access_token"].ToString();
			if (string.IsNullOrEmpty(authHeader) && !string.IsNullOrEmpty(authRequestQuery))
			{
				authHeader = $"Bearer {authRequestQuery}";
			}
			if (!AccessControlService.IsBearerValid(authHeader))
			{
				Context.Abort();
				return;
			}
		}
		await base.OnConnectedAsync();
	}
}
