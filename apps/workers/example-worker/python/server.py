from concurrent import futures
import os
import signal

import grpc

import handler_pb2
import handler_pb2_grpc


class Handler(handler_pb2_grpc.HandlerServicer):
    def Handle(self, request, _context):
        return handler_pb2.HandleResponse(
            outcome=handler_pb2.OUTCOME_SUCCESS,
            publications=[
                handler_pb2.Publication(
                    id=f"{request.id}:example",
                    body=request.body,
                )
            ],
        )


def main():
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=64))
    handler_pb2_grpc.add_HandlerServicer_to_server(Handler(), server)
    server.add_insecure_port(f"0.0.0.0:{os.getenv('HANDLER_GRPC_PORT', '9000')}")
    server.start()

    stopping = False

    def stop(*_args):
        nonlocal stopping
        if not stopping:
            stopping = True
            server.stop(30)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    server.wait_for_termination()


if __name__ == "__main__":
    main()
