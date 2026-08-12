import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

const definition = protoLoader.loadSync(
  new URL('../../../../packages/queueworker/runtime/v1/handler.proto', import.meta.url).pathname,
  {
    keepCase: true,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true
  }
);
const packages = grpc.loadPackageDefinition(definition) as unknown as {
  pandoks: {
    queueworker: {
      runtime: {
        v1: { Handler: grpc.ServiceClientConstructor };
      };
    };
  };
};
const runtime = packages.pandoks.queueworker.runtime.v1;
const server = new grpc.Server();

server.addService(runtime.Handler.service, {
  // Protobuf RPC method names are part of the generated service contract.
  // eslint-disable-next-line @typescript-eslint/naming-convention
  Handle(
    call: grpc.ServerUnaryCall<{ id: string; body: Uint8Array }, unknown>,
    callback: grpc.sendUnaryData<unknown>
  ) {
    callback(null, {
      outcome: 'OUTCOME_SUCCESS',
      publications: [
        {
          id: `${call.request.id}:example`,
          body: call.request.body
        }
      ]
    });
  }
});

server.bindAsync(
  `0.0.0.0:${process.env.HANDLER_GRPC_PORT ?? '9000'}`,
  grpc.ServerCredentials.createInsecure(),
  (error) => {
    if (error) throw error;
  }
);

const stop = () => server.tryShutdown(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
