import { ConnectionContainerModule } from "@theia/core/lib/node/messaging/connection-container-module";
import { ConnectionHandler } from "@theia/core/lib/common/messaging/handler";
import { MiziNimConnectionService } from "./mizi-nim-connection-service";

export const miziNimConnectionModule = ConnectionContainerModule.create(({ bind }) => {
  bind(MiziNimConnectionService).toSelf().inSingletonScope();

  // Eagerly create the connection service when a frontend connects,
  // so models are registered with the per-connection LanguageModelRegistry.
  // The dummy handler is registered but never triggered (no frontend connects to its path).
  bind(ConnectionHandler).toDynamicValue(ctx => {
    ctx.container.get(MiziNimConnectionService);
    return { path: "_mizi_nim_eager_init", onConnection: () => {} };
  }).inSingletonScope();
});
