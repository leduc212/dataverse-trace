using System;
using System.Threading;
using Microsoft.Xrm.Sdk;

namespace DataverseTrace.TestPlugins
{
    // Register these on the account table (see README.md for the exact steps). Put commands in the
    // account's Description and save:
    //   #fail       AccountValidate throws, so the save fails and rolls back
    //   #slow       AccountPostUpdate waits 2.5 s (a slow sync plugin)
    //   #nest       AccountPostUpdate updates the account's Fax, which runs AccountAudit at depth 2
    //   #loop       AccountPostUpdate keeps updating the description until depth 8, then throws
    //   #failasync  AccountNotifyAsync throws (a failed system job)

    /// <summary>Pre-validation, sync, Update of account, filtering: description.</summary>
    public sealed class AccountValidate : PluginBase
    {
        protected override void Run(Run run)
        {
            run.Trace($"Validating description ({run.Description.Length} characters)");
            if (run.Has("#fail") && !run.Has("#failasync"))
            {
                run.Trace("Found #fail: rejecting the save");
                throw new InvalidPluginExecutionException("Dataverse Trace test: #fail in the description rejects this save.");
            }
            run.Trace("Description is fine");
        }
    }

    /// <summary>Post-operation, sync, Update of account, filtering: description. Post-image "post" with description.</summary>
    public sealed class AccountPostUpdate : PluginBase
    {
        protected override void Run(Run run)
        {
            var id = run.Context.PrimaryEntityId;
            if (run.Has("#slow"))
            {
                run.Trace("Found #slow: simulating a slow external call (2.5 s)");
                Thread.Sleep(2500);
                run.Trace("External call returned 200");
            }
            if (run.Has("#nest") && run.Context.Depth == 1)
            {
                run.Trace("Found #nest: updating fax, which runs AccountAudit at depth 2");
                run.Service.Update(new Entity("account", id) { ["fax"] = DateTime.UtcNow.ToString("HH:mm:ss.fff") });
            }
            if (run.Has("#loop"))
            {
                if (run.Context.Depth >= 8)
                {
                    run.Trace($"Depth {run.Context.Depth}: stopping the loop");
                    throw new InvalidPluginExecutionException($"Dataverse Trace test: recursive update stopped at depth {run.Context.Depth}.");
                }
                run.Trace($"Found #loop at depth {run.Context.Depth}: updating the description again");
                run.Service.Update(new Entity("account", id) { ["description"] = $"{run.Description.Split('|')[0].Trim()} | depth {run.Context.Depth + 1}" });
            }
        }
    }

    /// <summary>Post-operation, sync, Update of account, NO filtering attributes: runs on every update (a finding the dashboard flags).</summary>
    public sealed class AccountAudit : PluginBase
    {
        protected override void Run(Run run)
        {
            var columns = run.Target == null ? "(no target)" : string.Join(", ", run.Target.Attributes.Keys);
            run.Trace($"Changed columns: {columns}");
            run.Trace($"{{\"audit\":\"account\",\"id\":\"{run.Context.PrimaryEntityId}\",\"depth\":{run.Context.Depth}}}");
        }
    }

    /// <summary>Post-operation, ASYNC, Update of account, filtering: description. Post-image "post" with description.</summary>
    public sealed class AccountNotifyAsync : PluginBase
    {
        protected override void Run(Run run)
        {
            run.Trace("Preparing a notification");
            Thread.Sleep(new Random().Next(200, 800));
            if (run.Has("#failasync"))
            {
                run.Trace("Found #failasync: the notification service is down");
                throw new InvalidPluginExecutionException("Dataverse Trace test: #failasync makes this system job fail.");
            }
            run.Trace("Notification queued");
        }
    }
}
