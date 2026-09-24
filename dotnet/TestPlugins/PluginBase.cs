using System;
using System.Diagnostics;
using Microsoft.Xrm.Sdk;

namespace DataverseTrace.TestPlugins
{
    /// <summary>
    /// Shared plumbing: resolves services, traces entry/exit with timing, and exposes the "commands"
    /// typed into the account's description (for example "#nest #slow") that control what the test
    /// plugins do. Nothing happens unless a command is present, apart from tracing.
    /// </summary>
    public abstract class PluginBase : IPlugin
    {
        public void Execute(IServiceProvider serviceProvider)
        {
            var context = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));
            var tracing = (ITracingService)serviceProvider.GetService(typeof(ITracingService));
            var factory = (IOrganizationServiceFactory)serviceProvider.GetService(typeof(IOrganizationServiceFactory));
            var service = factory.CreateOrganizationService(context.UserId);

            var name = GetType().Name;
            var timer = Stopwatch.StartNew();
            tracing.Trace($"Entered {name}: {context.MessageName} of {context.PrimaryEntityName} {context.PrimaryEntityId}, depth {context.Depth}, stage {context.Stage}, mode {(context.Mode == 0 ? "sync" : "async")}");
            tracing.Trace($"Correlation {context.CorrelationId}, request {context.RequestId}, initiating user {context.InitiatingUserId}");
            try
            {
                Run(new Run(context, service, tracing));
            }
            finally
            {
                tracing.Trace($"Exiting {name} after {timer.ElapsedMilliseconds} ms");
            }
        }

        protected abstract void Run(Run run);
    }

    /// <summary>Everything a test plugin needs for one execution.</summary>
    public sealed class Run
    {
        public Run(IPluginExecutionContext context, IOrganizationService service, ITracingService tracing)
        {
            Context = context;
            Service = service;
            Tracing = tracing;
        }

        public IPluginExecutionContext Context { get; }
        public IOrganizationService Service { get; }
        public ITracingService Tracing { get; }

        /// <summary>The target entity for Create/Update, or null.</summary>
        public Entity Target =>
            Context.InputParameters.Contains("Target") ? Context.InputParameters["Target"] as Entity : null;

        /// <summary>
        /// The account description, from the target or the post-image named "post" (register one with
        /// the "description" column on post-operation steps).
        /// </summary>
        public string Description
        {
            get
            {
                if (Target != null && Target.Contains("description")) return Target.GetAttributeValue<string>("description") ?? "";
                if (Context.PostEntityImages.Contains("post")) return Context.PostEntityImages["post"].GetAttributeValue<string>("description") ?? "";
                return "";
            }
        }

        public bool Has(string command) => Description.IndexOf(command, StringComparison.OrdinalIgnoreCase) >= 0;

        public void Trace(string message) => Tracing.Trace(message);
    }
}
