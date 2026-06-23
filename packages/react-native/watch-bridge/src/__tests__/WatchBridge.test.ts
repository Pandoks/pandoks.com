import { send, setContext, transfer } from '../WatchBridge';
import WatchBridgeModule from '../WatchBridgeModule';

jest.mock('../WatchBridgeModule', () => ({
  __esModule: true,
  default: {
    send: jest.fn().mockResolvedValue(true),
    transfer: jest.fn().mockResolvedValue(true),
    setContext: jest.fn().mockResolvedValue(true)
  }
}));

const mockedModule = jest.mocked(WatchBridgeModule);

describe('WatchBridge raw API', () => {
  beforeEach(() => jest.clearAllMocks());

  it('forwards the send payload to the native module', async () => {
    await send({ kind: 'ping', text: 'hi' });
    expect(mockedModule.send).toHaveBeenCalledWith({ kind: 'ping', text: 'hi' });
  });

  it('forwards the transfer payload', async () => {
    await transfer({ kind: 'log', n: 1 });
    expect(mockedModule.transfer).toHaveBeenCalledWith({ kind: 'log', n: 1 });
  });

  it('forwards the setContext payload', async () => {
    await setContext({ unread: 3 });
    expect(mockedModule.setContext).toHaveBeenCalledWith({ unread: 3 });
  });
});
