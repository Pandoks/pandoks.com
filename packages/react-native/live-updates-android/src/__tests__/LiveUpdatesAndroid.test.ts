import {
  addLiveUpdateInteractionListener,
  canPromoteLiveUpdates,
  endLiveUpdate,
  getActiveLiveUpdates,
  requestLiveUpdatePermissions,
  startLiveUpdate,
  updateLiveUpdate
} from '../LiveUpdatesAndroid';
import LiveUpdatesAndroidModule from '../LiveUpdatesAndroidModule';

jest.mock('../LiveUpdatesAndroidModule', () => ({
  __esModule: true,
  default: {
    requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
    canPromote: jest.fn().mockReturnValue(true),
    start: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    end: jest.fn().mockResolvedValue(undefined),
    getActive: jest.fn().mockResolvedValue([]),
    addListener: jest.fn().mockReturnValue({ remove: jest.fn() })
  }
}));

const mockedModule = jest.mocked(LiveUpdatesAndroidModule);

describe('LiveUpdatesAndroid', () => {
  beforeEach(() => jest.clearAllMocks());

  it('serializes the config to JSON before handing it to the native module', async () => {
    await startLiveUpdate('Focus', {
      title: 'Deep work',
      chronometer: { startedAt: 42 },
      actions: [{ target: 'stop', label: 'End session' }]
    });
    expect(mockedModule.start).toHaveBeenCalledWith(
      'Focus',
      JSON.stringify({
        title: 'Deep work',
        chronometer: { startedAt: 42 },
        actions: [{ target: 'stop', label: 'End session' }]
      })
    );
  });

  it('forwards updates and ends', async () => {
    await updateLiveUpdate('Focus', { title: 'Break' });
    expect(mockedModule.update).toHaveBeenCalledWith('Focus', JSON.stringify({ title: 'Break' }));
    await endLiveUpdate('Focus');
    expect(mockedModule.end).toHaveBeenCalledWith('Focus');
  });

  it('lists active live updates', async () => {
    mockedModule.getActive.mockResolvedValueOnce(['Focus']);
    await expect(getActiveLiveUpdates()).resolves.toEqual(['Focus']);
  });

  it('maps the permission response to a boolean', async () => {
    await expect(requestLiveUpdatePermissions()).resolves.toBe(true);
    mockedModule.requestPermissionsAsync.mockResolvedValueOnce({ granted: false });
    await expect(requestLiveUpdatePermissions()).resolves.toBe(false);
  });

  it('exposes promotion capability and interaction subscription', () => {
    expect(canPromoteLiveUpdates()).toBe(true);
    const listener = jest.fn();
    addLiveUpdateInteractionListener(listener);
    expect(mockedModule.addListener).toHaveBeenCalledWith('onLiveUpdateInteraction', listener);
  });
});
