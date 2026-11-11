# SingIt OpenClaw provider

This repository-only package (`@singitai/openclaw`, not published) is not the official OpenClaw `clawrouter` and is not `@blockrun/clawrouter`. It registers only `singit` and never enables or changes the bundled provider.

Install with `curl -fsSL https://singitai.app/singit-openclaw-install | bash` (live after merge, Pages deploy and the `@singitai/proxy` npm publish; tarball and checkout alternatives are in [the setup guide](../docs/openclaw.md)), and roll back with `singit-openclaw uninstall` (restores the newest `openclaw.json` backup or removes only the SingIt entries; the wallet is kept). The launcher and config merge are described in [the setup guide](../docs/openclaw.md). This plugin only describes models; the existing `@singitai/proxy` handles inference at `http://127.0.0.1:8787/v1`. It holds no wallet. Set `SINGIT_PROXY_PORT` for a different local port, or configure `models.providers.singit.baseUrl` in OpenClaw. Auth is `none` in the provider config; the registration has no interactive auth methods. Dynamic model preparation reads the local catalog; synchronous resolution passes unknown IDs through. Auto/free aliases also resolve in the proxy.

The zero cost metadata is a routing placeholder, not a promise of free paid models. Paid service usage is capped by the proxy.

After Kostya's OK, the future installation command will be `openclaw plugins install npm:@singitai/openclaw`. The `npm:` prefix is required: without it OpenClaw searches ClawHub without falling back to npm. No package has been published here. Compatibility/build version claims are omitted because this source has not been tested against a released Gateway.

The skill remains at `skills/singit/` in the repository; it is not referenced outside this package's layout. ClawHub publishing needs Kostya's OK and has not been done.

API references: [manifest](https://docs.openclaw.ai/plugins/manifest), [provider plugins](https://docs.openclaw.ai/plugins/sdk-provider-plugins).
